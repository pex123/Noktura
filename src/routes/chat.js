// Conversations, messages, attachments and money sent inside a chat.
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { route, str, httpError, limit, amountOf, idempotent, money } = require('../lib');
const rt = require('../realtime');
const { transfer } = require('../ledger');
const { userByHandle } = require('./people');

const r = express.Router();

const msgOut = m => ({
  id: m.id, chatId: m.chat_id, from: m.from_user, text: m.deleted_at ? '' : m.text, kind: m.deleted_at ? 'deleted' : m.kind,
  meta: m.deleted_at ? {} : m.meta, at: Number(m.created_at),
});

r.get('/chats', requireAuth, route(async (req, res) => {
  const rows = await db.all(`
    SELECT c.id, c.type, c.name, c.slug, cm.last_read_at, cm.muted, lm.from_user, lm.text, lm.kind, lm.deleted_at, lm.created_at AS lm_at,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.created_at > cm.last_read_at AND m.from_user <> $2)::int AS unread
    FROM chat_members cm JOIN chats c ON c.id = cm.chat_id
    LEFT JOIN LATERAL (SELECT from_user, text, kind, deleted_at, created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) lm ON TRUE
    WHERE cm.user_id = $1 ORDER BY COALESCE(lm.created_at, c.created_at) DESC LIMIT 200`, [req.user.id, req.user.handle]);
  const ids = rows.map(r => r.id);
  const members = ids.length ? await db.all(`SELECT cm.chat_id, u.id, u.handle, u.avatar, u.avatar_upload, u.display_name FROM chat_members cm
    JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ANY($1)`, [ids]) : [];
  const counts = new Map();
  members.forEach(m => counts.set(m.chat_id, (counts.get(m.chat_id) || 0) + 1));
  res.json({
    chats: rows.map(c => {
      const ms = members.filter(m => m.chat_id === c.id);
      const other = c.type === 'dm' ? ms.find(m => m.id !== req.user.id) : null;
      return {
        id: c.id, type: c.type, unread: c.unread, muted: c.muted, memberCount: counts.get(c.id) || 0,
        name: other ? (other.display_name || '@' + other.handle) : c.name,
        handle: other?.handle || null, avatar: other?.avatar || (c.name || '#')[0].toUpperCase(),
        avatarUrl: other?.avatar_upload ? '/api/uploads/' + other.avatar_upload : '',
        online: other ? rt.isOnline(other.id) : false,
        members: ms.length <= 12 ? ms.map(m => ({ handle: m.handle, avatar: m.avatar })) : [],
        lastMessage: c.lm_at ? { from: c.from_user, text: c.deleted_at ? 'Message deleted' : (c.kind === 'payment' ? 'Payment' : c.text), at: Number(c.lm_at) } : null,
      };
    }),
  });
}));

r.post('/chats', requireAuth, limit('chat-create', 40, 3600000), route(async (req, res) => {
  const { type, name, members } = req.body || {};
  if (!Array.isArray(members) || !members.length || members.length > 200) return res.status(400).json({ error: 'Choose at least one person.' });
  const found = (await Promise.all([...new Set(members.map(String))].slice(0, 200).map(h => userByHandle(h)))).filter(u => u && u.id !== req.user.id && !u.is_demo);
  const users = [];
  for (const u of found) if (!(await rt.blockedBetween(req.user.id, u.id))) users.push(u);
  if (!users.length) return res.status(404).json({ error: 'No matching people found.' });
  const isGroup = type === 'group' || users.length > 1;
  if (!isGroup) {
    const existing = await db.one(`SELECT c.id FROM chats c
      JOIN chat_members a ON a.chat_id = c.id AND a.user_id = $1
      JOIN chat_members b ON b.chat_id = c.id AND b.user_id = $2 WHERE c.type = 'dm' LIMIT 1`, [req.user.id, users[0].id]);
    if (existing) return res.json({ chatId: existing.id, reused: true });
  }
  const chatId = db.uid('chat'), now = Date.now(), title = str(name, 60) || 'New group';
  await db.tx(async c => {
    await c.query('INSERT INTO chats (id, type, name, created_at) VALUES ($1,$2,$3,$4)', [chatId, isGroup ? 'group' : 'dm', isGroup ? title : null, now]);
    for (const u of [req.user, ...users]) await c.query('INSERT INTO chat_members (chat_id, user_id, last_read_at) VALUES ($1,$2,$3)', [chatId, u.id, u.id === req.user.id ? now : 0]);
  });
  for (const u of [req.user, ...users]) { rt.joinUserToChat(u.id, chatId); rt.toUser(u.id, 'chat_created', { chatId }); }
  if (isGroup) await rt.postMessage({ chatId, user: null, text: `@${req.user.handle} created ${title}`, kind: 'system' });
  res.status(201).json({ chatId, reused: false });
}));

async function member(req) {
  const m = await db.one('SELECT cm.*, c.type, c.name FROM chat_members cm JOIN chats c ON c.id = cm.chat_id WHERE cm.chat_id = $1 AND cm.user_id = $2', [req.params.id, req.user.id]);
  if (!m) throw httpError(403, 'You are not in this conversation.');
  return m;
}

r.get('/chats/:id', requireAuth, route(async (req, res) => {
  const m = await member(req);
  const people = await db.all('SELECT u.id, u.handle, u.avatar, u.avatar_upload, u.display_name FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = $1 ORDER BY u.handle LIMIT 500', [req.params.id]);
  const other = m.type === 'dm' ? people.find(p => p.id !== req.user.id) : null;
  res.json({
    chat: { id: req.params.id, type: m.type, name: other ? (other.display_name || '@' + other.handle) : m.name, handle: other?.handle || null, muted: m.muted },
    members: people.map(p => ({ handle: p.handle, avatar: p.avatar, avatarUrl: p.avatar_upload ? '/api/uploads/' + p.avatar_upload : '', online: rt.isOnline(p.id) })),
  });
}));

r.get('/chats/:id/messages', requireAuth, route(async (req, res) => {
  await member(req);
  const before = Number(req.query.before) || Date.now() + 1;
  const rows = await db.all('SELECT * FROM (SELECT * FROM messages WHERE chat_id = $1 AND created_at < $2 ORDER BY created_at DESC LIMIT 80) m ORDER BY created_at ASC', [req.params.id, before]);
  await db.query('UPDATE chat_members SET last_read_at = $3 WHERE chat_id = $1 AND user_id = $2', [req.params.id, req.user.id, Date.now()]);
  res.json({ messages: rows.map(msgOut), hasMore: rows.length === 80 });
}));

// REST fallback for clients without a socket (and for tests).
r.post('/chats/:id/messages', requireAuth, limit('msg', 40, 10000), route(async (req, res) => {
  const m = await member(req);
  const text = str(req.body?.text, 4000);
  if (!text) throw httpError(400, 'Write a message first.');
  if (m.type === 'dm') {
    const other = await db.one('SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id <> $2', [req.params.id, req.user.id]);
    if (other && (await rt.blockedBetween(req.user.id, other.user_id))) throw httpError(403, 'You can’t message this person.');
  }
  const msg = await rt.postMessage({ chatId: req.params.id, user: req.user, text });
  res.status(201).json({ message: msg });
}));

r.delete('/chats/:id/messages/:mid', requireAuth, route(async (req, res) => {
  await member(req);
  const m = await db.one("UPDATE messages SET deleted_at = $3, text = '' WHERE id = $1 AND chat_id = $2 AND user_id = $4 AND deleted_at IS NULL RETURNING id", [req.params.mid, req.params.id, Date.now(), req.user.id]);
  if (!m) throw httpError(404, 'Message not found.');
  rt.toChat(req.params.id, 'message_deleted', { chatId: req.params.id, id: req.params.mid });
  res.json({ ok: true });
}));

r.post('/chats/:id/read', requireAuth, route(async (req, res) => {
  await member(req);
  await db.query('UPDATE chat_members SET last_read_at = $3 WHERE chat_id = $1 AND user_id = $2', [req.params.id, req.user.id, Date.now()]);
  res.json({ ok: true });
}));
r.post('/chats/:id/mute', requireAuth, route(async (req, res) => {
  await member(req);
  await db.query('UPDATE chat_members SET muted = $3 WHERE chat_id = $1 AND user_id = $2', [req.params.id, req.user.id, !!req.body?.muted]);
  res.json({ ok: true });
}));
r.post('/chats/:id/leave', requireAuth, route(async (req, res) => {
  const m = await member(req);
  if (m.type === 'dm') throw httpError(400, 'You can only leave group chats.');
  await db.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  await rt.postMessage({ chatId: req.params.id, user: null, text: `@${req.user.handle} left`, kind: 'system' });
  res.json({ ok: true });
}));
r.post('/chats/:id/members', requireAuth, route(async (req, res) => {
  const m = await member(req);
  if (m.type === 'dm') throw httpError(400, 'Start a group to add more people.');
  const u = await userByHandle(req.body?.handle);
  if (!u || u.is_demo) throw httpError(404, 'No one goes by that handle.');
  const ins = await db.query('INSERT INTO chat_members (chat_id, user_id, last_read_at) VALUES ($1,$2,0) ON CONFLICT DO NOTHING', [req.params.id, u.id]);
  if (ins.rowCount) {
    rt.joinUserToChat(u.id, req.params.id);
    rt.toUser(u.id, 'chat_created', { chatId: req.params.id });
    await rt.postMessage({ chatId: req.params.id, user: null, text: `@${req.user.handle} added @${u.handle}`, kind: 'system' });
  }
  res.json({ ok: true });
}));

// Send NKT to someone in this chat — "this round's on me".
r.post('/chats/:id/pay', requireAuth, limit('pay', 30, 60000), idempotent(async (req, res) => {
  const m = await member(req);
  const amount = amountOf(req.body?.amount, { min: 0.5, max: 2000 });
  const note = str(req.body?.note, 140);
  let target;
  if (m.type === 'dm') {
    const other = await db.one('SELECT u.* FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = $1 AND cm.user_id <> $2', [req.params.id, req.user.id]);
    target = other;
  } else {
    target = await userByHandle(req.body?.toHandle);
    if (target && !(await rt.isMember(req.params.id, target.id))) target = null;
  }
  if (!target) throw httpError(400, 'Choose who to pay.');
  if (await rt.blockedBetween(req.user.id, target.id)) throw httpError(403, 'You can’t pay this person.');
  const { balance } = await db.tx(c => transfer(c, { from: req.user, to: target, amount, note: note || 'Sent in chat' }));
  const msg = await rt.postMessage({ chatId: req.params.id, user: req.user, text: `Sent ${amount.toFixed(2)} NKT to @${target.handle}${note ? ' — ' + note : ''}`, kind: 'payment', meta: { amount, to: target.handle, note } });
  await rt.notify(target.id, 'payment', { from: req.user.handle, amount, message: `@${req.user.handle} sent you ${amount.toFixed(2)} NKT${note ? ': ' + note : '.'}` });
  rt.toUser(target.id, 'wallet_update', { reason: 'received' });
  res.json({ ok: true, balance, message: msg });
}));

// ── uploads ───────────────────────────────────────────
// Files live in Postgres (max 8 MB). IDs are 128-bit random, so a file is
// only reachable by people it was shared with. For heavy media at scale,
// swap this for object storage (S3/R2) behind the same two endpoints.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'audio/mpeg', 'audio/webm', 'audio/ogg']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PURPOSES = new Set(['chat', 'post', 'event', 'listing', 'avatar']);
const MAGIC = [[/^image\/png$/, [0x89, 0x50, 0x4e, 0x47]], [/^image\/jpeg$/, [0xff, 0xd8, 0xff]], [/^image\/gif$/, [0x47, 0x49, 0x46]], [/^image\/webp$/, [0x52, 0x49, 0x46, 0x46]], [/^application\/pdf$/, [0x25, 0x50, 0x44, 0x46]]];

r.post('/uploads', requireAuth, limit('upload', 40, 3600000), route(async (req, res) => {
  const { filename, contentType, data, chatId } = req.body || {};
  const purpose = PURPOSES.has(req.body?.purpose) ? req.body.purpose : 'chat';
  if (purpose === 'chat' && (!chatId || !(await rt.isMember(chatId, req.user.id)))) throw httpError(403, 'Open a conversation first.');
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) throw httpError(400, 'The file is empty.');
  if (buf.length > 8 * 1024 * 1024) throw httpError(413, 'Choose a file smaller than 8 MB.');
  let type = /^[\w.+-]+\/[\w.+-]+$/.test(String(contentType)) ? String(contentType).toLowerCase() : 'application/octet-stream';
  if (purpose !== 'chat' && !IMAGE_TYPES.has(type)) throw httpError(400, 'Choose a PNG, JPEG, GIF or WebP image.');
  const magic = MAGIC.find(([re]) => re.test(type));
  if (magic && !magic[1].every((b, i) => buf[i] === b)) throw httpError(400, 'That file does not match its type.');
  const id = crypto.randomBytes(16).toString('hex');
  await db.query('INSERT INTO uploads (id, user_id, chat_id, filename, content_type, size, data, purpose, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, req.user.id, purpose === 'chat' ? chatId : null, str(filename, 120).replace(/[\r\n"\\/]/g, '') || 'file', type, buf.length, buf, purpose, Date.now()]);
  res.status(201).json({ id, url: '/api/uploads/' + id, contentType: type, size: buf.length });
}));
r.get('/uploads/:id', route(async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.status(404).end();
  const f = await db.one('SELECT filename, content_type, data FROM uploads WHERE id = $1', [req.params.id]);
  if (!f) return res.status(404).json({ error: 'File not found.' });
  const inline = INLINE_TYPES.has(f.content_type);
  res.set({
    'Content-Type': inline ? f.content_type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.filename)}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'private, max-age=604800, immutable',
  }).send(f.data);
}));

module.exports = { router: r, money };

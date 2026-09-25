require('dotenv').config();
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const db = require('./db');
const paypal = require('./paypal');
const { seedDemoData } = require('./seed');
const { signup, login, requireAuth, verifyToken, publicUser, httpError, cleanAvatar } = require('./auth');
const { money } = db;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
const smallJson = express.json({ limit: '100kb' });
const uploadJson = express.json({ limit: '12mb' });
app.use((req, res, next) => (req.path === '/api/uploads' ? uploadJson : smallJson)(req, res, next));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

// ───────────────────────── helpers ─────────────────────────
const route = fn => (req, res, next) => fn(req, res, next).catch(next);
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const today = () => new Date().toISOString().slice(0, 10);
const baseUrl = req => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const amountOf = (v, { min = 0.01, max = 10000 } = {}) => {
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n < min || n > max) throw httpError(400, `Enter an amount between ${min.toFixed(2)} and ${max.toFixed(2)}.`);
  return n;
};

const online = new Map(); // userId -> Set(socketId)
const isOnline = id => online.has(id);

async function notify(userId, type, payload, client) {
  const n = { id: db.uid('n'), createdAt: Date.now() };
  await db.query('INSERT INTO notifications (id, user_id, type, payload, created_at) VALUES ($1,$2,$3,$4,$5)', [n.id, userId, type, JSON.stringify(payload), n.createdAt], client);
  io.to('user:' + userId).emit('notification', { id: n.id, type, payload, at: n.createdAt, read: false });
}

async function debit(client, userId, amount) {
  const r = await db.one('UPDATE users SET balance = balance - $2 WHERE id = $1 AND balance >= $2 RETURNING balance', [userId, amount], client);
  if (!r) throw httpError(400, 'Insufficient balance.');
  return money(r.balance);
}
async function credit(client, userId, amount) {
  const r = await db.one('UPDATE users SET balance = balance + $2 WHERE id = $1 RETURNING balance', [userId, amount], client);
  return money(r?.balance);
}
async function ledger(client, { fromId = null, toId = null, fromLabel, toLabel, amount, type, note = '', ref = null }) {
  const id = db.uid('tx');
  await client.query(`INSERT INTO transactions (id, from_user_id, to_user_id, from_label, to_label, amount, type, note, external_ref, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, fromId, toId, fromLabel, toLabel, amount, type, note, ref, Date.now()]);
  return id;
}
const userByHandle = (h, client) => db.one('SELECT * FROM users WHERE lower(handle) = lower($1)', [String(h || '').replace(/^@/, '')], client);
const friendIds = async userId => (await db.all('SELECT friend_id FROM friends WHERE user_id = $1', [userId])).map(r => r.friend_id);

async function joinCommunityChats(user) {
  const now = Date.now();
  const chats = [['general', 'Noktura general']];
  if (user.city) chats.push(['city:' + user.city.toLowerCase(), user.city + ' social']);
  for (const [slug, name] of chats) {
    await db.query("INSERT INTO chats (id, type, name, slug, created_at) VALUES ($1,'group',$2,$3,$4) ON CONFLICT (slug) DO NOTHING",
      [slug === 'general' ? 'grp_noktura_general' : db.uid('grp'), name, slug, now]);
    const chat = await db.one('SELECT id FROM chats WHERE slug = $1', [slug]);
    await db.query('INSERT INTO chat_members (chat_id, user_id, last_read_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [chat.id, user.id, now]);
  }
}

// Login throttling: 20 attempts / 15 min per IP.
const attempts = new Map();
function throttle(req) {
  const key = req.ip, now = Date.now();
  const a = (attempts.get(key) || []).filter(t => now - t < 15 * 60000);
  if (a.length >= 20) throw httpError(429, 'Too many attempts. Try again in a few minutes.');
  a.push(now); attempts.set(key, a);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of attempts) if (!v.some(t => now - t < 15 * 60000)) attempts.delete(k); }, 10 * 60000).unref();

// ───────────────────────── health / config ─────────────────────────
app.get('/api/health', route(async (req, res) => {
  await db.query('SELECT 1');
  res.json({ ok: true, online: online.size });
}));

app.get('/config.js', (req, res) => {
  const cfg = {
    tileUrl: process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: process.env.TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  };
  res.type('application/javascript').set('Cache-Control', 'no-cache')
    .send(`window.AXIS_API_BASE='';window.NOKTURA_CONFIG=${JSON.stringify(cfg).replace(/</g, '\\u003c')};`);
});

// ───────────────────────── auth / profile ─────────────────────────
app.post('/api/auth/signup', route(async (req, res) => {
  throttle(req);
  const result = await signup(req.body || {});
  await joinCommunityChats(result.user);
  res.json(result);
}));
app.post('/api/auth/login', route(async (req, res) => {
  throttle(req);
  res.json(await login(req.body || {}));
}));
app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user), online: true }));
app.patch('/api/me', requireAuth, route(async (req, res) => {
  const b = req.body || {};
  const avatar = b.avatar !== undefined ? cleanAvatar(b.avatar, req.user.handle) : req.user.avatar;
  const city = b.city !== undefined ? str(b.city, 60) : req.user.city;
  const u = await db.one('UPDATE users SET avatar = $2, city = $3 WHERE id = $1 RETURNING *', [req.user.id, avatar, city]);
  if (city && city !== req.user.city) await joinCommunityChats(u);
  res.json({ user: publicUser(u) });
}));

// ───────────────────────── users / friends ─────────────────────────
app.get('/api/users/search', requireAuth, route(async (req, res) => {
  const q = str(req.query.q, 40).replace(/^@/, '').toLowerCase().replace(/[%_\\]/g, m => '\\' + m);
  if (!q) return res.json({ users: [] });
  const rows = await db.all("SELECT * FROM users WHERE id <> $1 AND lower(handle) LIKE $2 ORDER BY (lower(handle) = $3) DESC, handle LIMIT 12", [req.user.id, '%' + q + '%', q]);
  res.json({ users: rows.map(u => ({ ...publicUser(u), balance: undefined, online: isOnline(u.id) })) });
}));

app.get('/api/friends', requireAuth, route(async (req, res) => {
  const rows = await db.all('SELECT u.* FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = $1 ORDER BY u.handle', [req.user.id]);
  res.json({ friends: rows.map(u => ({ ...publicUser(u), balance: undefined, online: isOnline(u.id) })) });
}));
app.post('/api/friends/:handle', requireAuth, route(async (req, res) => {
  const target = await userByHandle(req.params.handle);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't add yourself." });
  const r = await db.query('INSERT INTO friends VALUES ($1,$2,$3),($2,$1,$3) ON CONFLICT DO NOTHING', [req.user.id, target.id, Date.now()]);
  if (r.rowCount) await notify(target.id, 'friend_request', { from: req.user.handle, message: `@${req.user.handle} added you as a friend.` });
  res.json({ ok: true });
}));
app.delete('/api/friends/:handle', requireAuth, route(async (req, res) => {
  const target = await userByHandle(req.params.handle);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  await db.query('DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)', [req.user.id, target.id]);
  await db.query('DELETE FROM close_friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)', [req.user.id, target.id]);
  res.json({ ok: true });
}));

app.get('/api/close-friends', requireAuth, route(async (req, res) => {
  const rows = await db.all('SELECT u.handle FROM close_friends c JOIN users u ON u.id = c.friend_id WHERE c.user_id = $1', [req.user.id]);
  res.json({ closeFriends: rows.map(r => r.handle) });
}));
app.post('/api/close-friends/:handle', requireAuth, route(async (req, res) => {
  const target = await userByHandle(req.params.handle);
  if (!target || !(await db.one('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [req.user.id, target.id]))) return res.status(400).json({ error: 'Add them as a friend first.' });
  await db.query('INSERT INTO close_friends VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.user.id, target.id, Date.now()]);
  res.json({ ok: true });
}));
app.delete('/api/close-friends/:handle', requireAuth, route(async (req, res) => {
  const target = await userByHandle(req.params.handle);
  if (target) await db.query('DELETE FROM close_friends WHERE user_id = $1 AND friend_id = $2', [req.user.id, target.id]);
  res.json({ ok: true });
}));

// ───────────────────────── chats ─────────────────────────
app.get('/api/chats', requireAuth, route(async (req, res) => {
  const rows = await db.all(`
    SELECT c.id, c.type, c.name, cm.last_read_at, lm.from_user, lm.text, lm.created_at AS lm_at,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.created_at > cm.last_read_at AND m.from_user <> $2)::int AS unread
    FROM chat_members cm JOIN chats c ON c.id = cm.chat_id
    LEFT JOIN LATERAL (SELECT from_user, text, created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) lm ON TRUE
    WHERE cm.user_id = $1`, [req.user.id, req.user.handle]);
  const members = rows.length ? await db.all(`SELECT cm.chat_id, u.id, u.handle, u.avatar FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ANY($1)`, [rows.map(r => r.id)]) : [];
  res.json({
    chats: rows.map(c => ({
      id: c.id, type: c.type, name: c.name, unread: c.unread,
      members: members.filter(m => m.chat_id === c.id).map(m => ({ handle: m.handle, avatar: m.avatar, online: isOnline(m.id) })),
      lastMessage: c.lm_at ? { from: c.from_user, text: c.text, at: Number(c.lm_at) } : null,
    })),
  });
}));

app.post('/api/chats', requireAuth, route(async (req, res) => {
  const { type, name, members } = req.body || {};
  if (!Array.isArray(members) || !members.length || members.length > 100) return res.status(400).json({ error: 'Choose at least one person.' });
  const users = (await Promise.all([...new Set(members.map(String))].map(h => userByHandle(h)))).filter(u => u && u.id !== req.user.id);
  if (!users.length) return res.status(404).json({ error: 'No matching people found.' });
  const isGroup = type === 'group' || users.length > 1;
  if (!isGroup) {
    const existing = await db.one(`SELECT c.id FROM chats c
      JOIN chat_members a ON a.chat_id = c.id AND a.user_id = $1
      JOIN chat_members b ON b.chat_id = c.id AND b.user_id = $2 WHERE c.type = 'dm' LIMIT 1`, [req.user.id, users[0].id]);
    if (existing) return res.json({ chatId: existing.id, reused: true });
  }
  const chatId = db.uid('chat'), now = Date.now();
  await db.tx(async c => {
    await c.query('INSERT INTO chats (id, type, name, created_at) VALUES ($1,$2,$3,$4)', [chatId, isGroup ? 'group' : 'dm', isGroup ? (str(name, 60) || 'New group') : null, now]);
    for (const u of [req.user, ...users]) await c.query('INSERT INTO chat_members (chat_id, user_id, last_read_at) VALUES ($1,$2,$3)', [chatId, u.id, u.id === req.user.id ? now : 0]);
    if (isGroup) await c.query("INSERT INTO messages (id, chat_id, from_user, text, created_at) VALUES ($1,$2,'system',$3,$4)", [db.uid('m'), chatId, `Group created by @${req.user.handle}`, now]);
  });
  for (const u of [req.user, ...users]) {
    io.in('user:' + u.id).socketsJoin('chat:' + chatId);
    io.to('user:' + u.id).emit('chat_created', { chatId });
  }
  for (const u of users) await notify(u.id, 'system', { message: isGroup ? `@${req.user.handle} added you to ${str(name, 60) || 'a group'}.` : `@${req.user.handle} started a chat with you.`, chatId });
  res.json({ chatId, reused: false });
}));

app.get('/api/chats/:id/messages', requireAuth, route(async (req, res) => {
  if (!(await db.one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [req.params.id, req.user.id]))) return res.status(403).json({ error: 'You are not in this conversation.' });
  const rows = await db.all('SELECT * FROM (SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 300) m ORDER BY created_at ASC', [req.params.id]);
  await db.query('UPDATE chat_members SET last_read_at = $3 WHERE chat_id = $1 AND user_id = $2', [req.params.id, req.user.id, Date.now()]);
  res.json({ messages: rows.map(m => ({ id: m.id, from: m.from_user, text: m.text, at: Number(m.created_at) })) });
}));

// File attachments for chats (stored in Postgres, max 8 MB).
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'audio/mpeg']);
app.post('/api/uploads', requireAuth, route(async (req, res) => {
  const { filename, contentType, data, chatId } = req.body || {};
  if (!chatId || !(await db.one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, req.user.id]))) return res.status(403).json({ error: 'Choose a conversation first.' });
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) return res.status(400).json({ error: 'The file is empty.' });
  if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'Choose a file smaller than 8 MB.' });
  const id = crypto.randomBytes(16).toString('hex');
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(String(contentType)) ? String(contentType).toLowerCase() : 'application/octet-stream';
  await db.query('INSERT INTO uploads (id, user_id, chat_id, filename, content_type, size, data, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, req.user.id, chatId, str(filename, 120).replace(/[\r\n"]/g, '') || 'file', type, buf.length, buf, Date.now()]);
  res.json({ id, url: '/api/uploads/' + id });
}));
app.get('/api/uploads/:id', route(async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.status(404).end();
  const f = await db.one('SELECT filename, content_type, data FROM uploads WHERE id = $1', [req.params.id]);
  if (!f) return res.status(404).json({ error: 'File not found.' });
  const inline = INLINE_TYPES.has(f.content_type);
  res.set({
    'Content-Type': inline ? f.content_type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.filename)}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
    'Cache-Control': 'private, max-age=86400',
  }).send(f.data);
}));

// ───────────────────────── notifications ─────────────────────────
app.get('/api/notifications', requireAuth, route(async (req, res) => {
  const rows = await db.all('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ notifications: rows.map(n => ({ id: n.id, type: n.type, payload: n.payload, read: n.read, at: Number(n.created_at) })) });
}));
app.post('/api/notifications/:id/read', requireAuth, route(async (req, res) => {
  await db.query('UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));
app.post('/api/notifications/read-all', requireAuth, route(async (req, res) => {
  await db.query('UPDATE notifications SET read = TRUE WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true });
}));

// ───────────────────────── feed ─────────────────────────
app.get('/api/posts', requireAuth, route(async (req, res) => {
  const rows = await db.all(`SELECT p.*, u.handle,
      (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id)::int AS comment_count,
      COALESCE((SELECT array_agg(lu.handle) FROM post_likes l JOIN users lu ON lu.id = l.user_id WHERE l.post_id = p.id), '{}') AS likers
    FROM posts p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 100`);
  res.json({
    posts: rows.map(p => ({
      id: p.id, from: p.anon ? 'anon' : p.handle, anon: p.anon, mine: p.user_id === req.user.id, text: p.text, at: Number(p.created_at),
      likes: p.likers, likeCount: p.likers.length, commentCount: p.comment_count, shareCount: p.share_count,
    })),
  });
}));
app.post('/api/posts', requireAuth, route(async (req, res) => {
  const text = str(req.body?.text, 2000);
  if (!text) return res.status(400).json({ error: 'Write something first.' });
  const id = db.uid('post');
  await db.query('INSERT INTO posts (id, user_id, anon, text, created_at) VALUES ($1,$2,$3,$4,$5)', [id, req.user.id, !!req.body.anon, text, Date.now()]);
  io.emit('new_post', { id });
  res.json({ id });
}));
app.delete('/api/posts/:id', requireAuth, route(async (req, res) => {
  await db.query('DELETE FROM posts WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  io.emit('new_post', { id: req.params.id });
  res.json({ ok: true });
}));
app.post('/api/posts/:id/like', requireAuth, route(async (req, res) => {
  const post = await db.one('SELECT * FROM posts WHERE id = $1', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const del = await db.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [post.id, req.user.id]);
  if (del.rowCount) return res.json({ liked: false });
  await db.query('INSERT INTO post_likes VALUES ($1,$2) ON CONFLICT DO NOTHING', [post.id, req.user.id]);
  if (post.user_id !== req.user.id) await notify(post.user_id, 'like', { from: req.user.handle, postId: post.id, message: `@${req.user.handle} liked your post.` });
  res.json({ liked: true });
}));
app.get('/api/posts/:id/comments', requireAuth, route(async (req, res) => {
  const rows = await db.all('SELECT c.*, u.handle, u.avatar FROM post_comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = $1 ORDER BY c.created_at LIMIT 300', [req.params.id]);
  res.json({ comments: rows.map(c => ({ id: c.id, from: c.handle, avatar: c.avatar, text: c.text, at: Number(c.created_at) })) });
}));
app.post('/api/posts/:id/comments', requireAuth, route(async (req, res) => {
  const text = str(req.body?.text, 1000);
  if (!text) return res.status(400).json({ error: 'Write a comment first.' });
  const post = await db.one('SELECT * FROM posts WHERE id = $1', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const c = { id: db.uid('c'), at: Date.now() };
  await db.query('INSERT INTO post_comments (id, post_id, user_id, text, created_at) VALUES ($1,$2,$3,$4,$5)', [c.id, post.id, req.user.id, text, c.at]);
  io.emit('new_comment', { postId: post.id });
  if (post.user_id !== req.user.id) await notify(post.user_id, 'comment', { from: req.user.handle, postId: post.id, message: `@${req.user.handle} commented on your post.` });
  res.json({ id: c.id, from: req.user.handle, avatar: req.user.avatar, text, at: c.at });
}));
app.post('/api/posts/:id/share', requireAuth, route(async (req, res) => {
  const post = await db.one('UPDATE posts SET share_count = share_count + 1 WHERE id = $1 RETURNING user_id, share_count', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  io.emit('new_share', { postId: req.params.id });
  if (post.user_id !== req.user.id) await notify(post.user_id, 'share', { from: req.user.handle, postId: req.params.id, message: `@${req.user.handle} shared your post.` });
  res.json({ ok: true, shareCount: post.share_count });
}));

// ───────────────────────── events & tickets ─────────────────────────
const eventOut = e => ({ id: e.id, title: e.title, description: e.description, venue: e.venue, dateText: e.date_text, priceUsd: money(e.price_usd), currency: e.currency, capacity: e.capacity, sold: e.sold, by: e.handle });
app.get('/api/events', requireAuth, route(async (req, res) => {
  const rows = await db.all('SELECT e.*, u.handle FROM events e JOIN users u ON u.id = e.user_id ORDER BY e.created_at DESC LIMIT 200');
  res.json({ events: rows.map(eventOut) });
}));
app.post('/api/events', requireAuth, route(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 120);
  if (!title) return res.status(400).json({ error: 'Enter a title.' });
  const price = b.priceUsd ? amountOf(b.priceUsd, { min: 0, max: 5000 }) : 0;
  const capacity = Math.max(1, Math.min(100000, parseInt(b.capacity, 10) || 200));
  const id = db.uid('ev');
  await db.query('INSERT INTO events (id, user_id, title, description, venue, date_text, price_usd, capacity, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, req.user.id, title, str(b.description, 2000), str(b.venue, 160), str(b.dateText, 80), price, capacity, Date.now()]);
  res.json({ ok: true, id });
}));
app.get('/api/events/external', requireAuth, route(async (req, res) => {
  const rows = await db.all('SELECT * FROM external_events ORDER BY starts_at ASC NULLS LAST LIMIT 80');
  res.json({ events: rows.map(e => ({ id: e.id, source: e.source, title: e.title, venue: e.venue, city: e.city, dateText: e.date_text, priceText: e.price_text, url: e.url, imageUrl: e.image_url, fetchedAt: Number(e.fetched_at) })) });
}));

function ticketCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'NK' + Array.from(crypto.randomBytes(8), b => alphabet[b % alphabet.length]).join('');
}

app.post('/api/cart/checkout', requireAuth, route(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const merged = new Map();
  for (const it of items) {
    const qty = parseInt(it.qty, 10);
    if (!it.evId || !(qty > 0 && qty <= 20)) return res.status(400).json({ error: 'Invalid ticket quantity.' });
    merged.set(String(it.evId), (merged.get(String(it.evId)) || 0) + qty);
  }
  if (!merged.size) return res.status(400).json({ error: 'Your cart is empty.' });
  const lines = [];
  for (const [evId, qty] of merged) {
    const e = await db.one('SELECT * FROM events WHERE id = $1', [evId]);
    if (!e) return res.status(404).json({ error: 'An event in your cart is no longer available.' });
    if (e.sold + qty > e.capacity) return res.status(400).json({ error: `Only ${Math.max(0, e.capacity - e.sold)} tickets left for ${e.title}.` });
    lines.push({ evId, title: e.title, qty, price: money(e.price_usd) });
  }
  const subtotal = money(lines.reduce((s, l) => s + l.price * l.qty, 0));
  const total = money(subtotal * 1.12);
  const base = baseUrl(req);
  let orderId, approveUrl, provider;
  if (total === 0) {
    provider = 'free'; orderId = db.uid('free'); approveUrl = base + '/paypal-return.html?free=1';
  } else {
    provider = 'paypal';
    ({ orderId, approveUrl } = await paypal.createOrder({ amount: total, description: 'NOKTURA tickets: ' + lines.map(l => l.qty + '× ' + l.title).join(', '), returnUrl: base + '/paypal-return.html', cancelUrl: base + '/paypal-return.html?cancelled=1' }));
  }
  await db.query('INSERT INTO payment_orders (id, user_id, kind, provider, amount, items, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [orderId, req.user.id, 'cart', provider, total, JSON.stringify(lines), Date.now()]);
  res.json({ orderId, approveUrl, total });
}));

app.post('/api/cart/capture/:orderId', requireAuth, route(async (req, res) => {
  const order = await db.one("SELECT * FROM payment_orders WHERE id = $1 AND user_id = $2 AND kind = 'cart'", [req.params.orderId, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status === 'pending' && order.provider === 'paypal') {
    const paid = await paypal.captureOrder(order.id);
    if (paid + 0.01 < money(order.amount)) throw httpError(400, 'The PayPal amount does not match this order.');
  }
  const notifications = [];
  await db.tx(async c => {
    const o = await db.one('SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE', [order.id], c);
    if (o.status !== 'pending') return;
    const now = Date.now();
    for (const line of o.items) {
      const e = await db.one('SELECT * FROM events WHERE id = $1 FOR UPDATE', [line.evId], c);
      for (let i = 0; i < line.qty; i++) {
        await c.query('INSERT INTO tickets (id, user_id, event_id, title, code, price_paid, order_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [db.uid('tk'), req.user.id, line.evId, line.title, ticketCode(), line.price, o.id, now]);
      }
      if (e) {
        await c.query('UPDATE events SET sold = sold + $2 WHERE id = $1', [e.id, line.qty]);
        const revenue = money(line.price * line.qty);
        if (revenue > 0 && e.user_id !== req.user.id) {
          const organizer = await db.one('SELECT handle, is_demo FROM users WHERE id = $1', [e.user_id], c);
          if (organizer && !organizer.is_demo) {
            await credit(c, e.user_id, revenue);
            await ledger(c, { toId: e.user_id, fromLabel: req.user.handle, toLabel: organizer.handle, amount: revenue, type: 'ticket_sale', note: `Ticket sales: ${line.title} ×${line.qty}`, ref: o.id });
          }
        }
        if (e.user_id !== req.user.id) notifications.push([e.user_id, line]);
      }
    }
    await c.query("UPDATE payment_orders SET status = 'captured', captured_at = $2 WHERE id = $1", [o.id, now]);
  });
  for (const [uid, line] of notifications) {
    await notify(uid, 'system', { message: `@${req.user.handle} bought ${line.qty} ticket${line.qty > 1 ? 's' : ''} for ${line.title}.` });
    io.to('user:' + uid).emit('wallet_update', { reason: 'ticket_sale' });
  }
  const tickets = await db.all('SELECT title, tier_name, code FROM tickets WHERE order_id = $1 ORDER BY created_at', [order.id]);
  res.json({ tickets: tickets.map(t => ({ title: t.title, tierName: t.tier_name, code: t.code })), total: money(order.amount) });
}));

app.get('/api/tickets/mine', requireAuth, route(async (req, res) => {
  const rows = await db.all('SELECT * FROM tickets WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ tickets: rows.map(t => ({ id: t.id, eventId: t.event_id, title: t.title, code: t.code, pricePaid: money(t.price_paid), redeemed: !!t.redeemed_at, redeemedAt: t.redeemed_at ? Number(t.redeemed_at) : null, at: Number(t.created_at) })) });
}));

// Door check-in: organizers see/scan tickets for their events; holders see their own.
const guestOut = t => ({ code: t.code, name: '@' + t.handle, event: t.title, checked: t.redeemed_at ? Number(t.redeemed_at) : null });
app.get('/api/tickets/guests', requireAuth, route(async (req, res) => {
  const rows = await db.all(`SELECT t.*, u.handle FROM tickets t JOIN users u ON u.id = t.user_id LEFT JOIN events e ON e.id = t.event_id
    WHERE e.user_id = $1 OR t.user_id = $1 ORDER BY t.created_at DESC LIMIT 1000`, [req.user.id]);
  res.json({ guests: rows.map(guestOut) });
}));
app.post('/api/tickets/verify', requireAuth, route(async (req, res) => {
  const code = str(req.body?.code, 64).toUpperCase();
  if (!code) return res.status(400).json({ error: 'Enter a ticket code first.' });
  const t = await db.one(`SELECT t.*, u.handle, e.user_id AS organizer_id FROM tickets t JOIN users u ON u.id = t.user_id LEFT JOIN events e ON e.id = t.event_id
    WHERE t.code = $1`, [code]);
  if (!t || (t.organizer_id !== req.user.id && t.user_id !== req.user.id)) return res.json({ status: 'not_found' });
  if (t.redeemed_at) return res.json({ status: 'already', ticket: guestOut(t) });
  const r = await db.one('UPDATE tickets SET redeemed_at = $2, redeemed_by = $3 WHERE id = $1 AND redeemed_at IS NULL RETURNING redeemed_at', [t.id, Date.now(), req.user.id]);
  if (!r) return res.json({ status: 'already', ticket: guestOut(await db.one('SELECT t.*, u.handle FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = $1', [t.id])) });
  t.redeemed_at = r.redeemed_at;
  if (t.user_id !== req.user.id) await notify(t.user_id, 'system', { message: `Your ticket for ${t.title} was checked in. Enjoy the night!` });
  res.json({ status: 'ok', ticket: guestOut(t) });
}));

// ───────────────────────── wallet ─────────────────────────
app.get('/api/wallet', requireAuth, route(async (req, res) => {
  const me = await db.one('SELECT balance FROM users WHERE id = $1', [req.user.id]);
  const rows = await db.all('SELECT * FROM transactions WHERE from_user_id = $1 OR to_user_id = $1 ORDER BY created_at DESC LIMIT 200', [req.user.id]);
  res.json({
    balance: money(me.balance), paypalConfigured: paypal.configured(),
    transactions: rows.map(t => ({ id: t.id, amount: money(t.amount), type: t.type, note: t.note, from: t.from_label, to: t.to_label, direction: t.to_user_id === req.user.id ? 'in' : 'out', at: Number(t.created_at) })),
  });
}));

app.post('/api/wallet/transfer', requireAuth, route(async (req, res) => {
  const amount = amountOf(req.body?.amount);
  const target = await userByHandle(req.body?.toHandle);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't send NKT to yourself." });
  if (target.is_demo) return res.status(400).json({ error: `@${target.handle} is a demo account and can't receive NKT.` });
  const note = str(req.body?.note, 140);
  await db.tx(async c => {
    await debit(c, req.user.id, amount);
    await credit(c, target.id, amount);
    await ledger(c, { fromId: req.user.id, toId: target.id, fromLabel: req.user.handle, toLabel: target.handle, amount, type: 'transfer', note });
  });
  await notify(target.id, 'payment', { from: req.user.handle, amount, message: `@${req.user.handle} sent you ${amount.toFixed(2)} NKT.` });
  io.to('user:' + target.id).emit('wallet_update', { reason: 'received', amount, from: req.user.handle });
  res.json({ ok: true });
}));

app.post('/api/wallet/paypal/create-order', requireAuth, route(async (req, res) => {
  const amount = amountOf(req.body?.amount, { min: 1, max: 1000 });
  const base = baseUrl(req);
  const { orderId, approveUrl } = await paypal.createOrder({ amount, description: `NOKTURA top-up for @${req.user.handle}`, returnUrl: base + '/paypal-return.html', cancelUrl: base + '/paypal-return.html?cancelled=1' });
  await db.query("INSERT INTO payment_orders (id, user_id, kind, provider, amount, created_at) VALUES ($1,$2,'topup','paypal',$3,$4)", [orderId, req.user.id, amount, Date.now()]);
  res.json({ orderId, approveUrl });
}));

app.post('/api/wallet/paypal/capture/:orderId', requireAuth, route(async (req, res) => {
  const order = await db.one("SELECT * FROM payment_orders WHERE id = $1 AND user_id = $2 AND kind = 'topup'", [req.params.orderId, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Top-up not found.' });
  if (order.status === 'captured') return res.json({ credited: money(order.amount), alreadyCredited: true });
  const paid = await paypal.captureOrder(order.id);
  const credited = money(Math.min(paid, money(order.amount)));
  let balance;
  await db.tx(async c => {
    const o = await db.one('SELECT status FROM payment_orders WHERE id = $1 FOR UPDATE', [order.id], c);
    if (o.status !== 'pending') return;
    balance = await credit(c, req.user.id, credited);
    await ledger(c, { toId: req.user.id, fromLabel: 'PayPal', toLabel: req.user.handle, amount: credited, type: 'paypal_topup', note: 'PayPal top-up', ref: order.id });
    await c.query("UPDATE payment_orders SET status = 'captured', captured_at = $2 WHERE id = $1", [order.id, Date.now()]);
  });
  res.json({ credited, balance });
}));

app.post('/api/wallet/paypal/payout', requireAuth, route(async (req, res) => {
  if (!paypal.configured()) throw httpError(503, 'PayPal is not configured on this server yet. Nothing was withdrawn.');
  const amount = amountOf(req.body?.amount, { min: 1, max: 5000 });
  const email = str(req.body?.paypalEmail, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid PayPal email.' });
  const txId = await db.tx(async c => {
    await debit(c, req.user.id, amount);
    return ledger(c, { fromId: req.user.id, fromLabel: req.user.handle, toLabel: 'PayPal', amount, type: 'paypal_payout_pending', note: 'PayPal payout to ' + email });
  });
  try {
    const batchId = await paypal.payout({ amount, email, note: 'Your NOKTURA withdrawal', senderItemId: txId });
    await db.query("UPDATE transactions SET type = 'paypal_payout', external_ref = $2 WHERE id = $1", [txId, batchId]);
    res.json({ ok: true, batchId });
  } catch (e) {
    await db.tx(async c => {
      await c.query('DELETE FROM transactions WHERE id = $1', [txId]);
      await credit(c, req.user.id, amount);
    });
    throw httpError(e.status || 502, (e.message || 'PayPal payout failed') + ' Your balance was not charged.');
  }
}));

// ───────────────────────── marketplace ─────────────────────────
const CATEGORIES = new Set(['tickets', 'gear', 'art', 'clth', 'event', 'other']);
app.get('/api/market', requireAuth, route(async (req, res) => {
  const cat = str(req.query.category, 20);
  const rows = await db.all(`SELECT m.*, u.handle FROM market_items m JOIN users u ON u.id = m.seller_id
    WHERE m.status = 'active' AND ($1 = '' OR $1 = 'all' OR m.category = $1) ORDER BY m.created_at DESC LIMIT 200`, [cat]);
  res.json({ items: rows.map(i => ({ id: i.id, category: i.category, title: i.title, description: i.description, priceAxc: money(i.price_axc), seller: i.handle, mine: i.seller_id === req.user.id, createdAt: Number(i.created_at) })) });
}));
app.post('/api/market', requireAuth, route(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 120);
  if (!title) return res.status(400).json({ error: 'Enter an item title.' });
  const price = amountOf(b.priceAxc, { min: 0.01, max: 100000 });
  const id = db.uid('mkt');
  await db.query('INSERT INTO market_items (id, seller_id, category, title, description, price_axc, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, req.user.id, CATEGORIES.has(b.category) ? b.category : 'other', title, str(b.description, 1000), price, Date.now()]);
  res.json({ ok: true, id });
}));
app.delete('/api/market/:id', requireAuth, route(async (req, res) => {
  await db.query("UPDATE market_items SET status = 'removed' WHERE id = $1 AND seller_id = $2 AND status = 'active'", [req.params.id, req.user.id]);
  res.json({ ok: true });
}));
app.post('/api/market/:id/buy', requireAuth, route(async (req, res) => {
  let item;
  await db.tx(async c => {
    item = await db.one("SELECT m.*, u.handle FROM market_items m JOIN users u ON u.id = m.seller_id WHERE m.id = $1 FOR UPDATE OF m", [req.params.id], c);
    if (!item || item.status !== 'active') throw httpError(404, 'This listing is no longer available.');
    if (item.seller_id === req.user.id) throw httpError(400, 'This is your own listing.');
    const price = money(item.price_axc);
    await debit(c, req.user.id, price);
    await credit(c, item.seller_id, price);
    await ledger(c, { fromId: req.user.id, toId: item.seller_id, fromLabel: req.user.handle, toLabel: item.handle, amount: price, type: 'market_purchase', note: item.title });
    await c.query("UPDATE market_items SET status = 'sold', buyer_id = $2, sold_at = $3 WHERE id = $1", [item.id, req.user.id, Date.now()]);
  });
  await notify(item.seller_id, 'payment', { from: req.user.handle, amount: money(item.price_axc), message: `@${req.user.handle} bought "${item.title}" for ${money(item.price_axc).toFixed(2)} NKT.` });
  io.to('user:' + item.seller_id).emit('wallet_update', { reason: 'received', amount: money(item.price_axc), from: req.user.handle });
  res.json({ ok: true });
}));

// ───────────────────────── ads (earn) ─────────────────────────
app.get('/api/ads', requireAuth, route(async (req, res) => {
  const rows = await db.all(`SELECT a.*, u.handle FROM ads a JOIN users u ON u.id = a.user_id
    WHERE a.budget - a.spent >= a.reward_per_view
      AND (a.user_id = $1 OR NOT EXISTS (SELECT 1 FROM ad_views v WHERE v.ad_id = a.id AND v.user_id = $1))
    ORDER BY a.created_at DESC LIMIT 50`, [req.user.id]);
  res.json({ ads: rows.map(a => ({ id: a.id, title: a.title, body: a.body, link: a.link, budget: money(a.budget), spent: money(a.spent), rewardPerView: money(a.reward_per_view), by: a.handle, mine: a.user_id === req.user.id })) });
}));
app.post('/api/ads', requireAuth, route(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 80);
  if (!title) return res.status(400).json({ error: 'Enter a title.' });
  const budget = amountOf(b.budget, { min: 0.5, max: 10000 });
  const reward = Number(b.rewardPerView) > 0 ? amountOf(b.rewardPerView, { min: 0.01, max: budget }) : Math.min(0.1, budget);
  const link = str(b.link, 500);
  if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'The link must start with http:// or https://' });
  const id = db.uid('ad');
  await db.tx(async c => {
    await debit(c, req.user.id, budget);
    await ledger(c, { fromId: req.user.id, fromLabel: req.user.handle, toLabel: 'NOKTURA', amount: budget, type: 'ad_budget_hold', note: 'Ad budget: ' + title });
    await c.query('INSERT INTO ads (id, user_id, title, body, link, budget, reward_per_view, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, req.user.id, title, str(b.body, 300), link, budget, reward, Date.now()]);
  });
  res.json({ ok: true, id });
}));
app.post('/api/ads/:id/watch', requireAuth, route(async (req, res) => {
  const recent = await db.one('SELECT MAX(created_at) AS at FROM ad_views WHERE user_id = $1', [req.user.id]);
  if (recent?.at && Date.now() - Number(recent.at) < 8000) throw httpError(429, 'Watch the full ad to earn.');
  let reward;
  await db.tx(async c => {
    const ad = await db.one('SELECT * FROM ads WHERE id = $1 FOR UPDATE', [req.params.id], c);
    if (!ad) throw httpError(404, 'This ad is no longer running.');
    if (ad.user_id === req.user.id) throw httpError(400, "You can't earn from your own ad.");
    reward = money(ad.reward_per_view);
    if (money(ad.budget) - money(ad.spent) < reward) throw httpError(400, 'This ad has run out of budget.');
    const v = await c.query('INSERT INTO ad_views (ad_id, user_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ad.id, req.user.id, Date.now()]);
    if (!v.rowCount) throw httpError(400, 'Reward already claimed for this ad.');
    await c.query('UPDATE ads SET spent = spent + $2 WHERE id = $1', [ad.id, reward]);
    await credit(c, req.user.id, reward);
    await ledger(c, { toId: req.user.id, fromLabel: 'NOKTURA', toLabel: req.user.handle, amount: reward, type: 'ad_reward', note: 'Watched ad: ' + ad.title });
  });
  res.json({ ok: true, reward });
}));

// ───────────────────────── steps (earn) ─────────────────────────
const STEP_REWARDS = { 2500: 0.1, 5000: 0.2, 7500: 0.3, 10000: 0.5 };
app.post('/api/steps', requireAuth, route(async (req, res) => {
  const delta = parseInt(req.body?.delta, 10);
  if (!(delta > 0 && delta <= 2000)) return res.status(400).json({ error: 'Invalid step count.' });
  const r = await db.one(`INSERT INTO steps (user_id, day, steps) VALUES ($1,$2,LEAST($3, 100000))
    ON CONFLICT (user_id, day) DO UPDATE SET steps = LEAST(steps.steps + $3, 100000) RETURNING steps`, [req.user.id, today(), delta]);
  res.json({ steps: r.steps });
}));
app.get('/api/steps/today', requireAuth, route(async (req, res) => {
  const r = await db.one('SELECT steps FROM steps WHERE user_id = $1 AND day = $2', [req.user.id, today()]);
  res.json({ steps: r ? r.steps : 0 });
}));
app.get('/api/steps/leaderboard', requireAuth, route(async (req, res) => {
  const rows = await db.all('SELECT u.handle, u.avatar, s.steps FROM steps s JOIN users u ON u.id = s.user_id WHERE s.day = $1 AND s.steps > 0 ORDER BY s.steps DESC LIMIT 20', [today()]);
  res.json({ leaderboard: rows });
}));
app.post('/api/steps/claim-milestone', requireAuth, route(async (req, res) => {
  const milestone = parseInt(req.body?.milestone, 10);
  const reward = STEP_REWARDS[milestone];
  if (!reward) return res.status(400).json({ error: 'Unknown milestone.' });
  const day = today();
  await db.tx(async c => {
    const s = await db.one('SELECT steps FROM steps WHERE user_id = $1 AND day = $2', [req.user.id, day], c);
    if (!s || s.steps < milestone) throw httpError(400, 'Keep walking — milestone not reached yet.');
    const r = await c.query('INSERT INTO step_claims (user_id, day, milestone, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [req.user.id, day, milestone, Date.now()]);
    if (!r.rowCount) throw httpError(400, 'Already claimed today.');
    await credit(c, req.user.id, reward);
    await ledger(c, { toId: req.user.id, fromLabel: 'NOKTURA', toLabel: req.user.handle, amount: reward, type: 'step_milestone', note: milestone.toLocaleString('en-US') + ' step milestone' });
  });
  res.json({ ok: true, reward });
}));

// ───────────────────────── world map pins ─────────────────────────
const pinOut = (p, me) => ({
  id: p.id, type: p.type, title: p.title, subtitle: p.subtitle, description: p.description,
  lat: p.lat, lng: p.lng, priceUsd: p.price_usd == null ? null : money(p.price_usd), price: p.price_usd == null ? null : money(p.price_usd),
  visibility: p.visibility, eventId: p.event_id, live: p.is_live_location,
  by: p.handle, avatar: p.avatar, mine: p.user_id === me, createdAt: Number(p.created_at), updatedAt: Number(p.updated_at),
});
const PIN_SELECT = 'SELECT p.*, u.handle, u.avatar FROM pins p JOIN users u ON u.id = p.user_id';

async function broadcastPins(userId, visibility) {
  if (visibility === 'public') return io.emit('pins_changed', {});
  for (const id of [userId, ...(await friendIds(userId))]) io.to('user:' + id).emit('pins_changed', {});
}
function validLatLng(lat, lng) {
  lat = Number(lat); lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90) throw httpError(400, 'Invalid map position.');
  lng = ((((lng + 180) % 360) + 360) % 360) - 180; // wrap longitude into [-180, 180)
  return [lat, lng];
}
const visibilityOf = v => (['public', 'all_friends', 'close_friends'].includes(v) ? v : 'all_friends');

app.get('/api/pins', requireAuth, route(async (req, res) => {
  const rows = await db.all(`${PIN_SELECT}
    WHERE p.user_id = $1 OR p.visibility = 'public'
      OR (p.visibility = 'all_friends' AND EXISTS (SELECT 1 FROM friends f WHERE f.user_id = p.user_id AND f.friend_id = $1))
      OR (p.visibility = 'close_friends' AND EXISTS (SELECT 1 FROM close_friends c WHERE c.user_id = p.user_id AND c.friend_id = $1))
    ORDER BY p.created_at DESC LIMIT 3000`, [req.user.id]);
  res.json({ pins: rows.map(p => pinOut(p, req.user.id)) });
}));

async function upsertLiveLocation(user, lat, lng, visibility) {
  const now = Date.now();
  await db.query(`INSERT INTO pins (id, user_id, type, title, subtitle, lat, lng, visibility, is_live_location, created_at, updated_at)
    VALUES ($1,$2,'friend',$3,'Sharing location',$4,$5,$6,TRUE,$7,$7)
    ON CONFLICT (user_id) WHERE is_live_location DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, visibility = EXCLUDED.visibility, updated_at = EXCLUDED.updated_at`,
    [db.uid('pin'), user.id, '@' + user.handle, lat, lng, visibility, now]);
  return db.one(`${PIN_SELECT} WHERE p.user_id = $1 AND p.is_live_location`, [user.id]);
}

app.post('/api/pins', requireAuth, route(async (req, res) => {
  const b = req.body || {};
  const type = ['event', 'meetup', 'friend'].includes(b.type) ? b.type : null;
  if (!type) return res.status(400).json({ error: 'Choose a pin type.' });
  const [lat, lng] = validLatLng(b.lat, b.lng);
  const visibility = visibilityOf(b.visibility);
  let pin;
  if (type === 'friend') {
    pin = await upsertLiveLocation(req.user, lat, lng, visibility);
    if (b.description || b.subtitle) pin = await db.one(`UPDATE pins SET subtitle = $2, description = $3 WHERE id = $1 RETURNING *`, [pin.id, str(b.subtitle, 140) || 'Sharing location', str(b.description, 500)]).then(() => db.one(`${PIN_SELECT} WHERE p.id = $1`, [pin.id]));
  } else {
    const title = str(b.title, 100);
    if (!title) return res.status(400).json({ error: 'Add a name for your pin.' });
    const price = type === 'event' && b.priceUsd !== undefined && b.priceUsd !== null && b.priceUsd !== '' ? amountOf(b.priceUsd, { min: 0, max: 5000 }) : null;
    let eventId = null;
    if (b.eventId && (await db.one('SELECT 1 FROM events WHERE id = $1 AND user_id = $2', [b.eventId, req.user.id]))) eventId = b.eventId;
    const id = db.uid('pin'), now = Date.now();
    await db.query(`INSERT INTO pins (id, user_id, type, title, subtitle, description, lat, lng, price_usd, visibility, event_id, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`, [id, req.user.id, type, title, str(b.subtitle, 140), str(b.description, 500), lat, lng, price, visibility, eventId, now]);
    pin = await db.one(`${PIN_SELECT} WHERE p.id = $1`, [id]);
  }
  await broadcastPins(req.user.id, visibility);
  res.json({ ok: true, id: pin.id, pin: pinOut(pin, req.user.id) });
}));

app.post('/api/pins/friend-location', requireAuth, route(async (req, res) => {
  const [lat, lng] = validLatLng(req.body?.lat, req.body?.lng);
  const visibility = visibilityOf(req.body?.visibility);
  const pin = await upsertLiveLocation(req.user, lat, lng, visibility);
  await broadcastPins(req.user.id, visibility);
  res.json({ ok: true, id: pin.id, pin: pinOut(pin, req.user.id) });
}));
app.delete('/api/pins/friend-location', requireAuth, route(async (req, res) => {
  const p = await db.one('DELETE FROM pins WHERE user_id = $1 AND is_live_location RETURNING visibility', [req.user.id]);
  if (p) await broadcastPins(req.user.id, p.visibility);
  res.json({ ok: true });
}));

app.patch('/api/pins/:id', requireAuth, route(async (req, res) => {
  const p = await db.one('SELECT * FROM pins WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!p) return res.status(404).json({ error: 'Pin not found.' });
  const b = req.body || {};
  const [lat, lng] = b.lat !== undefined ? validLatLng(b.lat, b.lng) : [p.lat, p.lng];
  const visibility = b.visibility !== undefined ? visibilityOf(b.visibility) : p.visibility;
  await db.query(`UPDATE pins SET lat = $2, lng = $3, visibility = $4,
      title = COALESCE($5, title), subtitle = COALESCE($6, subtitle), description = COALESCE($7, description), updated_at = $8 WHERE id = $1`,
    [p.id, lat, lng, visibility, b.title !== undefined && p.type !== 'friend' ? (str(b.title, 100) || p.title) : null,
      b.subtitle !== undefined ? str(b.subtitle, 140) : null, b.description !== undefined ? str(b.description, 500) : null, Date.now()]);
  const pin = await db.one(`${PIN_SELECT} WHERE p.id = $1`, [p.id]);
  await broadcastPins(req.user.id, visibility === 'public' || p.visibility === 'public' ? 'public' : visibility);
  res.json({ ok: true, pin: pinOut(pin, req.user.id) });
}));
app.delete('/api/pins/:id', requireAuth, route(async (req, res) => {
  const p = await db.one('DELETE FROM pins WHERE id = $1 AND user_id = $2 RETURNING visibility', [req.params.id, req.user.id]);
  if (!p) return res.status(404).json({ error: 'Pin not found.' });
  await broadcastPins(req.user.id, p.visibility);
  res.json({ ok: true });
}));

// ───────────────────────── errors & static ─────────────────────────
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !err.status ? 'Something went wrong. Please try again.' : err.message });
});

const PUBLIC = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC, {
  setHeaders(res, file) {
    if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// ───────────────────────── realtime (Socket.IO) ─────────────────────────
io.use(async (socket, next) => {
  try {
    const payload = verifyToken(socket.handshake.auth?.token);
    const user = await db.one('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (!user) return next(new Error('Account no longer exists.'));
    socket.user = user;
    next();
  } catch (e) { next(new Error('Please log in again.')); }
});

const isMember = (chatId, userId) => db.one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
const safely = fn => async (...args) => { try { await fn(...args); } catch (e) { console.error('[socket]', e.message); } };

io.on('connection', async socket => {
  const user = socket.user;
  if (!online.has(user.id)) online.set(user.id, new Set());
  online.get(user.id).add(socket.id);
  socket.join('user:' + user.id);
  try {
    const chats = await db.all('SELECT chat_id FROM chat_members WHERE user_id = $1', [user.id]);
    chats.forEach(c => socket.join('chat:' + c.chat_id));
    for (const id of await friendIds(user.id)) io.to('user:' + id).emit('presence', { handle: user.handle, online: true });
  } catch (e) { console.error('[socket] join failed', e.message); }

  socket.on('send_message', safely(async ({ chatId, text } = {}) => {
    text = str(text, 4000);
    if (!chatId || !text) return;
    if (!(await isMember(chatId, user.id))) return socket.emit('error_message', { error: 'You are not in this conversation.' });
    const m = { id: db.uid('m'), chatId, from: user.handle, text, at: Date.now() };
    await db.query('INSERT INTO messages (id, chat_id, from_user, text, created_at) VALUES ($1,$2,$3,$4,$5)', [m.id, chatId, m.from, m.text, m.at]);
    await db.query('UPDATE chat_members SET last_read_at = $3 WHERE chat_id = $1 AND user_id = $2', [chatId, user.id, m.at]);
    io.to('chat:' + chatId).emit('new_message', m);
    const chat = await db.one('SELECT type FROM chats WHERE id = $1', [chatId]);
    if (chat.type === 'dm') {
      const others = await db.all('SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id <> $2', [chatId, user.id]);
      for (const o of others) await notify(o.user_id, 'message', { chatId, from: user.handle, preview: text.slice(0, 80) });
    }
  }));
  socket.on('typing', safely(async ({ chatId } = {}) => {
    if (chatId && socket.rooms.has('chat:' + chatId)) socket.to('chat:' + chatId).emit('typing', { chatId, from: user.handle });
  }));
  socket.on('join_chat', safely(async ({ chatId } = {}) => {
    if (chatId && (await isMember(chatId, user.id))) socket.join('chat:' + chatId);
  }));

  // WebRTC call signaling — the server only relays small handshake messages.
  const relayToChat = event => safely(async (data = {}) => {
    if (!data.chatId || !(await isMember(data.chatId, user.id))) return;
    socket.to('chat:' + data.chatId).emit(event, { ...data, from: user.handle });
  });
  const relayToUser = event => safely(async (data = {}) => {
    if (!data.chatId || !(await isMember(data.chatId, user.id))) return;
    const target = await userByHandle(data.to);
    if (target && (await isMember(data.chatId, target.id))) io.to('user:' + target.id).emit(event, { chatId: data.chatId, to: target.handle, from: user.handle });
  });
  socket.on('call_invite', safely(async (data = {}) => {
    if (!data.chatId || !(await isMember(data.chatId, user.id))) return;
    socket.to('chat:' + data.chatId).emit('call_invite', { chatId: data.chatId, from: user.handle, video: false });
  }));
  socket.on('call_signal', relayToChat('call_signal'));
  socket.on('call_end', relayToChat('call_end'));
  socket.on('call_accept', relayToUser('call_accept'));
  socket.on('call_reject', relayToUser('call_reject'));

  socket.on('disconnect', safely(async () => {
    const set = online.get(user.id);
    if (set) { set.delete(socket.id); if (!set.size) online.delete(user.id); }
    if (!isOnline(user.id)) for (const id of await friendIds(user.id)) io.to('user:' + id).emit('presence', { handle: user.handle, online: false });
  }));
});

// ───────────────────────── external events (optional) ─────────────────────────
async function syncExternalEvents() {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) return;
  const cities = (process.env.EXTERNAL_EVENT_CITIES || 'Belgrade').split(',').map(s => s.trim()).filter(Boolean);
  const now = Date.now();
  for (const city of cities) {
    try {
      const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${encodeURIComponent(key)}&city=${encodeURIComponent(city)}&classificationName=music&size=30&sort=date,asc`;
      const r = await fetch(url);
      if (!r.ok) { console.warn('[events] Ticketmaster', city, r.status); continue; }
      const data = await r.json();
      for (const e of data._embedded?.events || []) {
        const start = e.dates?.start?.dateTime ? Date.parse(e.dates.start.dateTime) : (e.dates?.start?.localDate ? Date.parse(e.dates.start.localDate) : null);
        const pr = e.priceRanges?.[0];
        await db.query(`INSERT INTO external_events (id, source, title, venue, city, date_text, price_text, url, image_url, starts_at, fetched_at)
          VALUES ($1,'ticketmaster',$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, venue = EXCLUDED.venue, date_text = EXCLUDED.date_text, price_text = EXCLUDED.price_text,
            url = EXCLUDED.url, image_url = EXCLUDED.image_url, starts_at = EXCLUDED.starts_at, fetched_at = EXCLUDED.fetched_at`,
          ['tm_' + e.id, str(e.name, 200), str(e._embedded?.venues?.[0]?.name, 160), city,
            [e.dates?.start?.localDate, e.dates?.start?.localTime?.slice(0, 5)].filter(Boolean).join(' · '),
            pr ? `${pr.min}${pr.max && pr.max !== pr.min ? '–' + pr.max : ''} ${pr.currency}` : '', e.url, e.images?.[0]?.url || '', Number.isFinite(start) ? start : null, now]);
      }
    } catch (e) { console.warn('[events] sync failed for', city, e.message); }
  }
  await db.query('DELETE FROM external_events WHERE starts_at IS NOT NULL AND starts_at < $1', [now - 86400000]);
}

// ───────────────────────── boot ─────────────────────────
const PORT = process.env.PORT || 4000;
(async () => {
  await db.migrate();
  if (process.env.SEED_DEMO_DATA !== 'false') await seedDemoData();
  server.listen(PORT, () => console.log(`[noktura] listening on :${PORT} (PayPal ${paypal.configured() ? 'enabled' : 'not configured'})`));
  setTimeout(() => syncExternalEvents().catch(e => console.warn('[events]', e.message)), 10000).unref();
  setInterval(() => syncExternalEvents().catch(e => console.warn('[events]', e.message)), 24 * 3600000).unref();
})().catch(e => {
  console.error('[noktura] failed to start:', e);
  process.exit(1);
});

module.exports = { app, server, io };

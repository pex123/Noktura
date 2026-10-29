// Accounts, profiles, friends, blocking, reporting, notifications, moderation.
const express = require('express');
const db = require('../db');
const { signup, login, requireAuth, optionalAuth, publicUser, cleanAvatar, changePassword, verifyPassword, issueToken } = require('../auth');
const { route, str, httpError, limit, handleOf, money } = require('../lib');
const rt = require('../realtime');
const { findCity } = require('../cities');

const r = express.Router();
const userByHandle = (h, client) => db.one('SELECT * FROM users WHERE lower(handle) = lower($1)', [handleOf(h)], client);
const areFriends = async (a, b) => !!(await db.one(`SELECT 1 FROM friends x JOIN friends y ON y.user_id = x.friend_id AND y.friend_id = x.user_id
  WHERE x.user_id = $1 AND x.friend_id = $2`, [a, b]));

async function joinCommunityChats(user) {
  const now = Date.now();
  const chats = [['general', 'NOKTURA — everyone']];
  if (user.city) chats.push(['city:' + user.city.toLowerCase(), user.city]);
  for (const [slug, name] of chats) {
    await db.query("INSERT INTO chats (id, type, name, slug, created_at) VALUES ($1,'group',$2,$3,$4) ON CONFLICT (slug) DO NOTHING",
      [slug === 'general' ? 'grp_noktura_general' : db.uid('grp'), name, slug, now]);
    const chat = await db.one('SELECT id FROM chats WHERE slug = $1', [slug]);
    await db.query('INSERT INTO chat_members (chat_id, user_id, last_read_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [chat.id, user.id, now]);
    rt.joinUserToChat(user.id, chat.id);
  }
}

// ── auth ─────────────────────────────────────────────
r.post('/auth/signup', limit('signup', 8, 3600000), route(async (req, res) => {
  const b = req.body || {};
  const known = findCity(b.city);
  if (known && b.cityLat == null) Object.assign(b, { city: known.name, cityLat: known.lat, cityLng: known.lng });
  const result = await signup(b);
  await joinCommunityChats(await db.one('SELECT * FROM users WHERE id = $1', [result.user.id]));
  res.status(201).json(result);
}));
r.post('/auth/login', limit('login', 30, 900000), route(async (req, res) => res.json(await login(req.body || {}, req.ip))));
r.post('/auth/logout-all', requireAuth, route(async (req, res) => {
  const u = await db.one('UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING *', [req.user.id]);
  res.json({ ok: true, token: issueToken(u) });
}));
r.post('/auth/password', requireAuth, limit('password', 10, 3600000), route(async (req, res) => {
  res.json(await changePassword(req.user, req.body?.current, req.body?.next));
}));

// ── me ───────────────────────────────────────────────
r.get('/me', requireAuth, route(async (req, res) => {
  const counts = await db.one(`SELECT
      (SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND NOT read)::int AS unread_notifications,
      (SELECT COUNT(*) FROM payment_requests WHERE to_user_id = $1 AND status = 'open')::int AS open_requests`, [req.user.id]);
  res.json({ user: publicUser(req.user, { self: true }), unreadNotifications: counts.unread_notifications, openRequests: counts.open_requests });
}));
r.patch('/me', requireAuth, route(async (req, res) => {
  const b = req.body || {}, u = req.user;
  let city = u.city, lat = u.city_lat, lng = u.city_lng;
  if (b.city !== undefined) {
    city = str(b.city, 60);
    const known = findCity(city);
    const bl = Number(b.cityLat), bg = Number(b.cityLng);
    if (Number.isFinite(bl) && Number.isFinite(bg) && Math.abs(bl) <= 90 && Math.abs(bg) <= 180) { lat = bl; lng = bg; }
    else if (known) { city = known.name; lat = known.lat; lng = known.lng; }
  }
  let avatarUpload = u.avatar_upload;
  if (b.avatarUpload !== undefined) {
    avatarUpload = null;
    if (b.avatarUpload && (await db.one("SELECT 1 FROM uploads WHERE id = $1 AND user_id = $2 AND content_type LIKE 'image/%'", [b.avatarUpload, u.id]))) avatarUpload = b.avatarUpload;
  }
  const updated = await db.one(`UPDATE users SET avatar = $2, city = $3, city_lat = $4, city_lng = $5, display_name = $6, bio = $7, avatar_upload = $8
    WHERE id = $1 RETURNING *`, [u.id, b.avatar !== undefined ? cleanAvatar(b.avatar, u.handle) : u.avatar, city, lat, lng,
    b.displayName !== undefined ? str(b.displayName, 40) : u.display_name, b.bio !== undefined ? str(b.bio, 280) : u.bio, avatarUpload]);
  if (city && city !== u.city) await joinCommunityChats(updated);
  res.json({ user: publicUser(updated, { self: true }) });
}));
r.get('/me/export', requireAuth, limit('export', 5, 3600000), route(async (req, res) => {
  const id = req.user.id;
  const [posts, comments, messages, events, tickets, transactions, listings, pins, friends] = await Promise.all([
    db.all('SELECT id, text, anon, city, created_at FROM posts WHERE user_id = $1', [id]),
    db.all('SELECT id, post_id, text, created_at FROM post_comments WHERE user_id = $1', [id]),
    db.all('SELECT id, chat_id, text, created_at FROM messages WHERE user_id = $1 AND deleted_at IS NULL', [id]),
    db.all('SELECT id, title, venue, starts_at, created_at FROM events WHERE user_id = $1', [id]),
    db.all('SELECT id, title, tier_name, code, price_paid, redeemed_at, created_at FROM tickets WHERE user_id = $1', [id]),
    db.all('SELECT id, from_label, to_label, amount, type, note, created_at FROM transactions WHERE from_user_id = $1 OR to_user_id = $1', [id]),
    db.all('SELECT id, title, price_axc, status, created_at FROM market_items WHERE seller_id = $1', [id]),
    db.all('SELECT id, type, title, lat, lng, visibility, created_at FROM pins WHERE user_id = $1', [id]),
    db.all('SELECT u.handle, f.created_at FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = $1', [id]),
  ]);
  res.set('Content-Disposition', `attachment; filename="noktura-${req.user.handle}.json"`);
  res.json({ exportedAt: new Date().toISOString(), account: publicUser(req.user, { self: true }), posts, comments, messages, events, tickets, transactions, listings, pins, following: friends });
}));
r.delete('/me', requireAuth, limit('delete-account', 5, 3600000), route(async (req, res) => {
  await verifyPassword(req.user, req.body?.password);
  const me = await db.one('SELECT balance FROM users WHERE id = $1', [req.user.id]);
  if (money(me.balance) >= 1 && req.body?.forfeitBalance !== true) throw httpError(400, `You still have ${money(me.balance).toFixed(2)} NKT. Withdraw it first, or confirm you want to give it up.`);
  const upcoming = await db.one(`SELECT COUNT(*)::int AS n FROM event_tiers t JOIN events e ON e.id = t.event_id
    WHERE e.user_id = $1 AND t.sold > 0 AND e.starts_at > $2 AND e.status = 'published'`, [req.user.id, Date.now()]);
  if (upcoming.n) throw httpError(400, 'You have upcoming events with tickets sold. Cancel them (buyers are refunded) before deleting your account.');
  await db.query('DELETE FROM users WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
}));

// ── people ───────────────────────────────────────────
const personOut = (u, me) => ({ ...publicUser(u), online: rt.isOnline(u.id), me: me === u.id });
r.get('/users/search', requireAuth, limit('search', 60, 60000), route(async (req, res) => {
  const q = str(req.query.q, 40).replace(/^@/, '').toLowerCase().replace(/[%_\\]/g, m => '\\' + m);
  if (!q) return res.json({ users: [] });
  const rows = await db.all(`SELECT * FROM users u WHERE id <> $1 AND NOT is_demo AND suspended_at IS NULL
      AND (lower(handle) LIKE $2 OR lower(display_name) LIKE $2)
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = u.id AND b.blocked_id = $1) OR (b.user_id = $1 AND b.blocked_id = u.id))
    ORDER BY (lower(handle) = $3) DESC, (lower(handle) LIKE $4) DESC, handle LIMIT 15`, [req.user.id, '%' + q + '%', q, q + '%']);
  res.json({ users: rows.map(u => personOut(u, req.user.id)) });
}));

r.get('/users/:handle', optionalAuth, route(async (req, res) => {
  const u = await userByHandle(req.params.handle);
  if (!u || u.suspended_at) return res.status(404).json({ error: 'No one goes by that handle.' });
  const me = req.user?.id;
  if (me && (await rt.blockedBetween(me, u.id)) && me !== u.id) return res.status(404).json({ error: 'No one goes by that handle.' });
  const [counts, rel] = await Promise.all([
    db.one(`SELECT (SELECT COUNT(*) FROM friends x JOIN friends y ON y.user_id = x.friend_id AND y.friend_id = x.user_id WHERE x.user_id = $1)::int AS friends,
      (SELECT COUNT(*) FROM posts WHERE user_id = $1 AND NOT anon)::int AS posts,
      (SELECT COUNT(*) FROM events WHERE user_id = $1 AND status = 'published')::int AS events`, [u.id]),
    me ? db.one(`SELECT EXISTS (SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2) AS following,
      EXISTS (SELECT 1 FROM friends WHERE user_id = $2 AND friend_id = $1) AS follows_me,
      EXISTS (SELECT 1 FROM close_friends WHERE user_id = $1 AND friend_id = $2) AS close,
      EXISTS (SELECT 1 FROM blocks WHERE user_id = $1 AND blocked_id = $2) AS blocked`, [me, u.id]) : null,
  ]);
  res.json({
    user: personOut(u, me), counts,
    relation: rel ? { following: rel.following, followsMe: rel.follows_me, friends: rel.following && rel.follows_me, close: rel.close, blocked: rel.blocked } : null,
  });
}));

// ── friends (two-way: you add, they add back) ───────────────
r.get('/friends', requireAuth, route(async (req, res) => {
  const rows = await db.all(`SELECT u.*, EXISTS (SELECT 1 FROM friends y WHERE y.user_id = u.id AND y.friend_id = $1) AS back,
      EXISTS (SELECT 1 FROM close_friends c WHERE c.user_id = $1 AND c.friend_id = u.id) AS close
    FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = $1 ORDER BY u.handle`, [req.user.id]);
  const incoming = await db.all(`SELECT u.* FROM friends f JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = $1 AND NOT EXISTS (SELECT 1 FROM friends y WHERE y.user_id = $1 AND y.friend_id = f.user_id) ORDER BY f.created_at DESC LIMIT 100`, [req.user.id]);
  res.json({
    friends: rows.filter(u => u.back).map(u => ({ ...personOut(u), close: u.close })),
    outgoing: rows.filter(u => !u.back).map(u => personOut(u)),
    incoming: incoming.map(u => personOut(u)),
  });
}));
r.post('/friends/:handle', requireAuth, limit('friend-add', 60, 3600000), route(async (req, res) => {
  const target = await userByHandle(req.params.handle);
  if (!target || target.is_demo) return res.status(404).json({ error: 'No one goes by that handle.' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't add yourself." });
  if (await rt.blockedBetween(req.user.id, target.id)) return res.status(404).json({ error: 'No one goes by that handle.' });
  const ins = await db.query('INSERT INTO friends VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.user.id, target.id, Date.now()]);
  const mutual = await areFriends(req.user.id, target.id);
  if (ins.rowCount) await rt.notify(target.id, mutual ? 'friend_accept' : 'friend_request', { from: req.user.handle, message: mutual ? `@${req.user.handle} accepted your friend request.` : `@${req.user.handle} wants to be friends.` });
  res.json({ ok: true, friends: mutual });
}));
r.delete('/friends/:handle', requireAuth, route(async (req, res) => {
  const target = await userByHandle(req.params.handle);
  if (!target) return res.status(404).json({ error: 'No one goes by that handle.' });
  await db.query('DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)', [req.user.id, target.id]);
  await db.query('DELETE FROM close_friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)', [req.user.id, target.id]);
  res.json({ ok: true });
}));
r.post('/close-friends/:handle', requireAuth, route(async (req, res) => {
  const target = await userByHandle(req.params.handle);
  if (!target || !(await areFriends(req.user.id, target.id))) return res.status(400).json({ error: 'You need to be friends first.' });
  await db.query('INSERT INTO close_friends VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.user.id, target.id, Date.now()]);
  res.json({ ok: true });
}));
r.delete('/close-friends/:handle', requireAuth, route(async (req, res) => {
  const target = await userByHandle(req.params.handle);
  if (target) await db.query('DELETE FROM close_friends WHERE user_id = $1 AND friend_id = $2', [req.user.id, target.id]);
  res.json({ ok: true });
}));

// ── blocking & reports ──────────────────────────────
r.get('/blocks', requireAuth, route(async (req, res) => {
  const rows = await db.all('SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = $1 ORDER BY b.created_at DESC', [req.user.id]);
  res.json({ blocked: rows.map(u => publicUser(u)) });
}));
r.post('/blocks/:handle', requireAuth, route(async (req, res) => {
  const target = await userByHandle(req.params.handle);
  if (!target || target.id === req.user.id) return res.status(400).json({ error: 'Choose someone else to block.' });
  await db.tx(async c => {
    await c.query('INSERT INTO blocks VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.user.id, target.id, Date.now()]);
    await c.query('DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)', [req.user.id, target.id]);
    await c.query('DELETE FROM close_friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)', [req.user.id, target.id]);
    await c.query("UPDATE payment_requests SET status = 'cancelled' WHERE status = 'open' AND ((from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1))", [req.user.id, target.id]);
  });
  res.json({ ok: true });
}));
r.delete('/blocks/:handle', requireAuth, route(async (req, res) => {
  const target = await userByHandle(req.params.handle);
  if (target) await db.query('DELETE FROM blocks WHERE user_id = $1 AND blocked_id = $2', [req.user.id, target.id]);
  res.json({ ok: true });
}));

const REPORT_TYPES = new Set(['user', 'post', 'comment', 'message', 'event', 'listing', 'pin']);
r.post('/reports', requireAuth, limit('report', 30, 3600000), route(async (req, res) => {
  const b = req.body || {};
  if (!REPORT_TYPES.has(b.targetType)) throw httpError(400, 'Choose what you are reporting.');
  const reason = str(b.reason, 60);
  if (!reason) throw httpError(400, 'Choose a reason.');
  await db.query('INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [db.uid('rep'), req.user.id, b.targetType, str(b.targetId, 80), reason, str(b.details, 1000), Date.now()]);
  res.status(201).json({ ok: true });
}));

// ── notifications ─────────────────────────────────────
r.get('/notifications', requireAuth, route(async (req, res) => {
  const rows = await db.all('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 60', [req.user.id]);
  res.json({ notifications: rows.map(n => ({ id: n.id, type: n.type, payload: n.payload, read: n.read, at: Number(n.created_at) })) });
}));
r.post('/notifications/read-all', requireAuth, route(async (req, res) => {
  await db.query('UPDATE notifications SET read = TRUE WHERE user_id = $1 AND NOT read', [req.user.id]);
  res.json({ ok: true });
}));
r.post('/notifications/:id/read', requireAuth, route(async (req, res) => {
  await db.query('UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// ── moderation (role = admin) ──────────────────────────
const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only.' }));
const REMOVERS = {
  post: id => db.query('DELETE FROM posts WHERE id = $1', [id]),
  comment: id => db.query('DELETE FROM post_comments WHERE id = $1', [id]),
  message: id => db.query("UPDATE messages SET deleted_at = $2, text = '' WHERE id = $1", [id, Date.now()]),
  event: id => db.query("UPDATE events SET status = 'removed' WHERE id = $1", [id]),
  listing: id => db.query("UPDATE market_items SET status = 'removed' WHERE id = $1", [id]),
  pin: id => db.query('DELETE FROM pins WHERE id = $1', [id]),
  user: id => db.query('UPDATE users SET suspended_at = $2, token_version = token_version + 1 WHERE id = $1', [id, Date.now()]),
};
r.get('/admin/reports', requireAuth, requireAdmin, route(async (req, res) => {
  const rows = await db.all(`SELECT r.*, u.handle AS reporter FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
    WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 200`, [str(req.query.status, 12) || 'open']);
  res.json({ reports: rows.map(x => ({ id: x.id, targetType: x.target_type, targetId: x.target_id, reason: x.reason, details: x.details, reporter: x.reporter, status: x.status, at: Number(x.created_at) })) });
}));
r.post('/admin/reports/:id', requireAuth, requireAdmin, route(async (req, res) => {
  const rep = await db.one('SELECT * FROM reports WHERE id = $1', [req.params.id]);
  if (!rep) throw httpError(404, 'Report not found.');
  const action = req.body?.action === 'remove' ? 'actioned' : 'dismissed';
  if (action === 'actioned') {
    let targetId = rep.target_id;
    if (rep.target_type === 'user') targetId = (await userByHandle(targetId))?.id || targetId;
    await REMOVERS[rep.target_type](targetId);
  }
  await db.query('UPDATE reports SET status = $2 WHERE id = $1', [rep.id, action]);
  res.json({ ok: true, status: action });
}));

module.exports = { router: r, userByHandle, areFriends, joinCommunityChats };

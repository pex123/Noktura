// The feed: city and friends timelines, photos, event cards, comments.
const express = require('express');
const db = require('../db');
const { requireAuth, optionalAuth } = require('../auth');
const { route, str, int, httpError, limit, httpUrl } = require('../lib');
const rt = require('../realtime');
const { eventOut, SELECT: EVENT_SELECT, safeId } = require('./events');

const r = express.Router();

const postOut = (p, me, events) => ({
  id: p.id, kind: p.kind, anon: p.anon, mine: !!me && p.user_id === me,
  author: p.anon ? { handle: 'anon', avatar: '?' } : { handle: p.handle, displayName: p.display_name, avatar: p.avatar, avatarUrl: p.avatar_upload ? '/api/uploads/' + p.avatar_upload : '', verified: !!p.is_verified, official: p.role === 'official' },
  headline: p.headline, text: p.text, city: p.city,
  image: p.image_upload ? '/api/uploads/' + p.image_upload : p.image_url,
  link: p.link_url ? { url: p.link_url, title: p.link_title || p.link_url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] } : null,
  event: p.event_id && events.has(p.event_id) ? events.get(p.event_id) : null,
  likeCount: p.like_count, commentCount: p.comment_count, shareCount: p.share_count, liked: !!p.liked,
  promoted: !!(p.promoted_until && Number(p.promoted_until) > Date.now()), at: Number(p.created_at),
});

async function attachEvents(rows, me) {
  const ids = [...new Set(rows.map(p => p.event_id).filter(Boolean))];
  if (!ids.length) return new Map();
  const evs = await db.all(`${EVENT_SELECT(safeId(me))} WHERE e.id = ANY($1) AND e.status = 'published'`, [ids]);
  return new Map(evs.map(e => [e.id, eventOut(e)]));
}

const POST_SELECT = me => `SELECT p.*, u.handle, u.display_name, u.avatar, u.avatar_upload, u.is_verified, u.role
  ${me ? `, EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = '${me}') AS liked` : ''}
  FROM posts p JOIN users u ON u.id = p.user_id`;

r.get('/posts', optionalAuth, limit('feed', 240, 60000), route(async (req, res) => {
  const me = safeId(req.user?.id);
  const scope = ['city', 'friends', 'all', 'user'].includes(req.query.scope) ? req.query.scope : 'city';
  const before = Number(req.query.before) || Date.now() + 1;
  const params = [before];
  const where = ['p.created_at < $1', 'u.suspended_at IS NULL'];
  if (me) where.push(`NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = '${me}' AND b.blocked_id = p.user_id) OR (b.user_id = p.user_id AND b.blocked_id = '${me}'))`);
  if (scope === 'city' && req.query.city) { params.push(str(req.query.city, 60)); where.push(`(lower(p.city) = lower($${params.length}) OR p.city = '')`); }
  if (scope === 'friends') {
    if (!me) throw httpError(401, 'Log in to see your friends’ posts.');
    where.push(`(p.user_id = '${me}' OR (NOT p.anon AND EXISTS (SELECT 1 FROM friends a JOIN friends b ON b.user_id = a.friend_id AND b.friend_id = a.user_id WHERE a.user_id = '${me}' AND a.friend_id = p.user_id)))`);
  }
  if (scope === 'user') { params.push(str(req.query.handle, 30)); where.push(`lower(u.handle) = lower($${params.length}) AND NOT p.anon`); }
  const size = int(req.query.limit, { min: 1, max: 50, fallback: 25 });
  const rows = await db.all(`${POST_SELECT(me)} WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT ${size}`, params);
  let promoted = [];
  if (!req.query.before && scope !== 'user') {
    const pp = [Date.now()];
    let cityCond = '';
    if (req.query.city) { pp.push(str(req.query.city, 60)); cityCond = `AND (lower(p.city) = lower($2) OR p.city = '')`; }
    promoted = await db.all(`${POST_SELECT(me)} WHERE p.promoted_until > $1 ${cityCond} AND u.suspended_at IS NULL ORDER BY random() LIMIT 2`, pp);
  }
  const ids = new Set(promoted.map(p => p.id));
  const all = [...promoted, ...rows.filter(p => !ids.has(p.id))];
  const events = await attachEvents(all, me);
  res.json({ posts: all.map(p => postOut(p, me, events)), nextBefore: rows.length === size ? Number(rows[rows.length - 1].created_at) : null });
}));

r.get('/posts/:id', optionalAuth, route(async (req, res) => {
  const me = safeId(req.user?.id);
  const p = await db.one(`${POST_SELECT(me)} WHERE p.id = $1`, [req.params.id]);
  if (!p) throw httpError(404, 'This post was deleted.');
  res.json({ post: postOut(p, me, await attachEvents([p], me)) });
}));

r.post('/posts', requireAuth, limit('post', 20, 600000), route(async (req, res) => {
  const b = req.body || {};
  const text = str(b.text, 2000);
  const imageUpload = b.imageUpload && (await db.one("SELECT 1 FROM uploads WHERE id = $1 AND user_id = $2 AND content_type LIKE 'image/%'", [b.imageUpload, req.user.id])) ? b.imageUpload : null;
  if (!text && !imageUpload) throw httpError(400, 'Write something or add a photo.');
  const eventId = b.eventId && (await db.one("SELECT 1 FROM events WHERE id = $1 AND status = 'published'", [b.eventId])) ? b.eventId : null;
  const id = db.uid('post');
  await db.query(`INSERT INTO posts (id, user_id, anon, text, city, image_upload, event_id, link_url, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, req.user.id, !!b.anon, text, str(b.city, 60) || req.user.city, imageUpload, eventId, httpUrl(b.linkUrl), Date.now()]);
  rt.broadcast('new_post', { id, city: str(b.city, 60) || req.user.city });
  res.status(201).json({ id });
}));
r.delete('/posts/:id', requireAuth, route(async (req, res) => {
  const d = await db.query('DELETE FROM posts WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!d.rowCount) throw httpError(404, 'Post not found.');
  rt.broadcast('post_deleted', { id: req.params.id });
  res.json({ ok: true });
}));

r.post('/posts/:id/like', requireAuth, limit('like', 240, 60000), route(async (req, res) => {
  const post = await db.one('SELECT id, user_id FROM posts WHERE id = $1', [req.params.id]);
  if (!post) throw httpError(404, 'Post not found.');
  const del = await db.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [post.id, req.user.id]);
  let liked = false;
  if (del.rowCount) await db.query('UPDATE posts SET like_count = GREATEST(0, like_count - 1) WHERE id = $1', [post.id]);
  else {
    const ins = await db.query('INSERT INTO post_likes VALUES ($1,$2) ON CONFLICT DO NOTHING', [post.id, req.user.id]);
    if (ins.rowCount) await db.query('UPDATE posts SET like_count = like_count + 1 WHERE id = $1', [post.id]);
    liked = true;
    if (post.user_id !== req.user.id) await rt.notify(post.user_id, 'like', { from: req.user.handle, postId: post.id, message: `@${req.user.handle} liked your post.` });
  }
  const c = await db.one('SELECT like_count FROM posts WHERE id = $1', [post.id]);
  res.json({ liked, likeCount: c.like_count });
}));

r.get('/posts/:id/comments', optionalAuth, route(async (req, res) => {
  const me = req.user?.id;
  const rows = await db.all(`SELECT c.*, u.handle, u.avatar, u.avatar_upload, p.user_id AS post_owner FROM post_comments c JOIN users u ON u.id = c.user_id JOIN posts p ON p.id = c.post_id
    WHERE c.post_id = $1 AND u.suspended_at IS NULL ORDER BY c.created_at LIMIT 500`, [req.params.id]);
  res.json({ comments: rows.map(c => ({ id: c.id, from: c.handle, avatar: c.avatar, avatarUrl: c.avatar_upload ? '/api/uploads/' + c.avatar_upload : '', text: c.text, at: Number(c.created_at), canDelete: !!me && (c.user_id === me || c.post_owner === me) })) });
}));
r.post('/posts/:id/comments', requireAuth, limit('comment', 30, 60000), route(async (req, res) => {
  const text = str(req.body?.text, 1000);
  if (!text) throw httpError(400, 'Write a comment first.');
  const post = await db.one('SELECT id, user_id FROM posts WHERE id = $1', [req.params.id]);
  if (!post) throw httpError(404, 'Post not found.');
  if (await rt.blockedBetween(req.user.id, post.user_id)) throw httpError(403, 'You can’t comment on this post.');
  const c = { id: db.uid('c'), at: Date.now() };
  await db.query('INSERT INTO post_comments (id, post_id, user_id, text, created_at) VALUES ($1,$2,$3,$4,$5)', [c.id, post.id, req.user.id, text, c.at]);
  await db.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [post.id]);
  rt.broadcast('new_comment', { postId: post.id });
  if (post.user_id !== req.user.id) await rt.notify(post.user_id, 'comment', { from: req.user.handle, postId: post.id, message: `@${req.user.handle}: ${text.slice(0, 80)}` });
  res.status(201).json({ id: c.id, from: req.user.handle, avatar: req.user.avatar, text, at: c.at, canDelete: true });
}));
r.delete('/comments/:id', requireAuth, route(async (req, res) => {
  const c = await db.one(`DELETE FROM post_comments c USING posts p WHERE c.id = $1 AND p.id = c.post_id AND (c.user_id = $2 OR p.user_id = $2) RETURNING c.post_id`, [req.params.id, req.user.id]);
  if (!c) throw httpError(404, 'Comment not found.');
  await db.query('UPDATE posts SET comment_count = GREATEST(0, comment_count - 1) WHERE id = $1', [c.post_id]);
  rt.broadcast('new_comment', { postId: c.post_id });
  res.json({ ok: true });
}));
r.post('/posts/:id/share', requireAuth, limit('share', 60, 60000), route(async (req, res) => {
  const post = await db.one('UPDATE posts SET share_count = share_count + 1 WHERE id = $1 RETURNING user_id, share_count', [req.params.id]);
  if (!post) throw httpError(404, 'Post not found.');
  res.json({ ok: true, shareCount: post.share_count });
}));

module.exports = { router: r };

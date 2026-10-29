// World map: event and meet-up pins, live friend locations, event markers.
const express = require('express');
const db = require('../db');
const { requireAuth, optionalAuth } = require('../auth');
const { route, str, httpError, limit, amountOf, bbox } = require('../lib');
const rt = require('../realtime');

const r = express.Router();
const VIS = ['public', 'all_friends', 'close_friends'];
const visibilityOf = v => (VIS.includes(v) ? v : 'all_friends');
const LIVE_TTL = 4 * 3600000;

const pinOut = (p, me) => ({
  id: p.id, type: p.type, title: p.title, subtitle: p.subtitle, description: p.description, lat: p.lat, lng: p.lng,
  price: p.price_usd == null ? null : Number(p.price_usd), visibility: p.visibility, eventId: p.event_id, live: p.is_live_location,
  startsAt: p.starts_at ? Number(p.starts_at) : null, promoted: !!(p.promoted_until && Number(p.promoted_until) > Date.now()),
  by: p.handle, avatar: p.avatar, mine: !!me && p.user_id === me, updatedAt: Number(p.updated_at),
});
const PIN_SELECT = 'SELECT p.*, u.handle, u.avatar FROM pins p JOIN users u ON u.id = p.user_id';
function validLatLng(lat, lng) {
  lat = Number(lat); lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90) throw httpError(400, 'Choose a spot on the map.');
  return [lat, ((((lng + 180) % 360) + 360) % 360) - 180];
}
async function broadcastPins(userId, visibility) {
  if (visibility === 'public') return rt.broadcast('pins_changed', {});
  for (const id of [userId, ...(await rt.friendIds(userId))]) rt.toUser(id, 'pins_changed', {});
}

// Pins in the visible map area that the viewer is allowed to see.
r.get('/pins', optionalAuth, limit('pins', 240, 60000), route(async (req, res) => {
  const me = req.user?.id || '';
  const params = [me, Date.now()];
  let area = '';
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const b = bbox(lat, lng, Math.min(400, Number(req.query.radius) || 60));
    params.push(b.minLat, b.maxLat, b.minLng, b.maxLng);
    area = 'AND p.lat BETWEEN $3 AND $4 AND p.lng BETWEEN $5 AND $6';
  }
  const rows = await db.all(`${PIN_SELECT}
    WHERE (p.expires_at IS NULL OR p.expires_at > $2) AND (NOT p.is_live_location OR p.updated_at > $2 - ${LIVE_TTL}) ${area}
      AND u.suspended_at IS NULL
      AND (p.user_id = $1 OR p.visibility = 'public'
        OR (p.visibility = 'all_friends' AND EXISTS (SELECT 1 FROM friends a JOIN friends b ON b.user_id = a.friend_id AND b.friend_id = a.user_id WHERE a.user_id = p.user_id AND a.friend_id = $1))
        OR (p.visibility = 'close_friends' AND EXISTS (SELECT 1 FROM close_friends c WHERE c.user_id = p.user_id AND c.friend_id = $1)))
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = $1 AND b.blocked_id = p.user_id) OR (b.user_id = p.user_id AND b.blocked_id = $1))
    ORDER BY (p.promoted_until IS NOT NULL AND p.promoted_until > $2) DESC, p.updated_at DESC LIMIT 2000`, params);
  res.json({ pins: rows.map(p => pinOut(p, me)) });
}));

async function upsertLive(user, lat, lng, visibility, note) {
  const now = Date.now();
  await db.query(`INSERT INTO pins (id, user_id, type, title, subtitle, lat, lng, visibility, is_live_location, created_at, updated_at)
    VALUES ($1,$2,'friend',$3,$4,$5,$6,$7,TRUE,$8,$8)
    ON CONFLICT (user_id) WHERE is_live_location DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, visibility = EXCLUDED.visibility,
      subtitle = EXCLUDED.subtitle, updated_at = EXCLUDED.updated_at`,
    [db.uid('pin'), user.id, '@' + user.handle, note || 'Out now', lat, lng, visibility, now]);
  return db.one(`${PIN_SELECT} WHERE p.user_id = $1 AND p.is_live_location`, [user.id]);
}

r.post('/pins', requireAuth, limit('pin', 30, 3600000), route(async (req, res) => {
  const b = req.body || {};
  const type = ['event', 'meetup', 'friend'].includes(b.type) ? b.type : null;
  if (!type) throw httpError(400, 'Choose a pin type.');
  const [lat, lng] = validLatLng(b.lat, b.lng);
  const visibility = visibilityOf(b.visibility);
  let pin;
  if (type === 'friend') pin = await upsertLive(req.user, lat, lng, visibility === 'public' ? 'all_friends' : visibility, str(b.subtitle, 80));
  else {
    const title = str(b.title, 100);
    if (!title) throw httpError(400, 'Name your pin.');
    const price = type === 'event' && b.price !== undefined && b.price !== null && b.price !== '' ? amountOf(b.price, { min: 0, max: 5000, label: 'price' }) : null;
    const eventId = b.eventId && (await db.one('SELECT 1 FROM events WHERE id = $1 AND user_id = $2', [b.eventId, req.user.id])) ? b.eventId : null;
    const startsAt = Number(b.startsAt) || null;
    const expiresAt = startsAt ? startsAt + 12 * 3600000 : Date.now() + 7 * 86400000;
    const id = db.uid('pin'), now = Date.now();
    await db.query(`INSERT INTO pins (id, user_id, type, title, subtitle, description, lat, lng, price_usd, visibility, event_id, starts_at, expires_at, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`, [id, req.user.id, type, title, str(b.subtitle, 140), str(b.description, 500), lat, lng, price, visibility, eventId, startsAt, expiresAt, now]);
    pin = await db.one(`${PIN_SELECT} WHERE p.id = $1`, [id]);
  }
  await broadcastPins(req.user.id, pin.visibility);
  res.status(201).json({ ok: true, pin: pinOut(pin, req.user.id) });
}));
r.post('/pins/live', requireAuth, limit('live', 240, 3600000), route(async (req, res) => {
  const [lat, lng] = validLatLng(req.body?.lat, req.body?.lng);
  const vis = visibilityOf(req.body?.visibility);
  const pin = await upsertLive(req.user, lat, lng, vis === 'public' ? 'all_friends' : vis, str(req.body?.note, 80));
  await broadcastPins(req.user.id, pin.visibility);
  res.json({ ok: true, pin: pinOut(pin, req.user.id) });
}));
r.delete('/pins/live', requireAuth, route(async (req, res) => {
  const p = await db.one('DELETE FROM pins WHERE user_id = $1 AND is_live_location RETURNING visibility', [req.user.id]);
  if (p) await broadcastPins(req.user.id, p.visibility);
  res.json({ ok: true });
}));
r.patch('/pins/:id', requireAuth, route(async (req, res) => {
  const p = await db.one('SELECT * FROM pins WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!p) throw httpError(404, 'Pin not found.');
  const b = req.body || {};
  const [lat, lng] = b.lat !== undefined ? validLatLng(b.lat, b.lng) : [p.lat, p.lng];
  const visibility = b.visibility !== undefined ? visibilityOf(b.visibility) : p.visibility;
  await db.query(`UPDATE pins SET lat = $2, lng = $3, visibility = $4, title = COALESCE($5, title), subtitle = COALESCE($6, subtitle), description = COALESCE($7, description), updated_at = $8 WHERE id = $1`,
    [p.id, lat, lng, visibility, b.title !== undefined && p.type !== 'friend' ? (str(b.title, 100) || p.title) : null,
      b.subtitle !== undefined ? str(b.subtitle, 140) : null, b.description !== undefined ? str(b.description, 500) : null, Date.now()]);
  await broadcastPins(req.user.id, visibility === 'public' || p.visibility === 'public' ? 'public' : visibility);
  res.json({ ok: true, pin: pinOut(await db.one(`${PIN_SELECT} WHERE p.id = $1`, [p.id]), req.user.id) });
}));
r.delete('/pins/:id', requireAuth, route(async (req, res) => {
  const p = await db.one('DELETE FROM pins WHERE id = $1 AND user_id = $2 RETURNING visibility', [req.params.id, req.user.id]);
  if (!p) throw httpError(404, 'Pin not found.');
  await broadcastPins(req.user.id, p.visibility);
  res.json({ ok: true });
}));

module.exports = { router: r };

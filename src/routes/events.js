// Events: discovery by city/date/category, RSVPs, tiered ticketing (wallet,
// PayPal or free), event chats, guest lists, door check-in and refunds.
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const paypal = require('../paypal');
const { requireAuth, optionalAuth } = require('../auth');
const { route, str, int, httpError, limit, amountOf, httpUrl, idempotent, money, bbox, zonedToEpoch, validZone } = require('../lib');
const rt = require('../realtime');
const { debit, credit, ledger, feeOn, PLATFORM_FEE_PCT } = require('../ledger');
const { CITIES, findCity } = require('../cities');
const sources = require('../sources');
const { userByHandle, areFriends } = require('./people');

const r = express.Router();
const CATEGORIES = ['club', 'concert', 'festival', 'theatre', 'art', 'film', 'talk', 'sport', 'food', 'other'];
const now = () => Date.now();
const baseUrl = req => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

r.get('/cities', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ cities: CITIES.map(({ name, country, lat, lng, tz }) => ({ name, country, lat, lng, tz })) });
});

// ── shaping ───────────────────────────────────────────
function eventOut(e, extra = {}) {
  const minPrice = e.min_price == null ? null : money(e.min_price);
  const native = e.source === 'noktura';
  return {
    id: e.id, source: e.source, sourceName: native ? 'NOKTURA' : e.source_name || e.source, title: e.title, description: e.description,
    venue: e.venue, address: e.address, city: e.city, country: e.country, lat: e.lat, lng: e.lng,
    startsAt: e.starts_at == null ? null : Number(e.starts_at), endsAt: e.ends_at == null ? null : Number(e.ends_at), tz: e.timezone,
    category: e.category, genres: e.genres, lineup: e.lineup, minAge: e.min_age,
    image: e.image_upload ? '/api/uploads/' + e.image_upload : e.image_url,
    priceText: native ? (minPrice == null ? '' : minPrice === 0 ? 'Free' : `From ${minPrice.toFixed(2)} NKT`) : e.price_text,
    minPrice, soldOut: native && e.remaining != null && Number(e.remaining) <= 0,
    externalUrl: e.external_url, status: e.status,
    by: e.handle ? { handle: e.handle, avatar: e.avatar, verified: !!e.is_verified, official: e.role === 'official' } : null,
    going: Number(e.going || 0), interested: Number(e.interested || 0), myRsvp: e.my_rsvp || null,
    friendsGoing: e.friends_going || [], promoted: !!(e.promoted_until && Number(e.promoted_until) > now()),
    ...extra,
  };
}

// Builds the WHERE clause for list queries from request filters.
function filters(q, me) {
  const where = ["e.status = 'published'", "e.visibility = 'public'"];
  const params = [];
  const p = v => { params.push(v); return '$' + params.length; };
  const lat = Number(q.lat), lng = Number(q.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const b = bbox(lat, lng, Math.min(200, Math.max(5, Number(q.radius) || 45)));
    where.push(`e.lat BETWEEN ${p(b.minLat)} AND ${p(b.maxLat)} AND e.lng BETWEEN ${p(b.minLng)} AND ${p(b.maxLng)}`);
  } else if (q.city) {
    where.push(`lower(e.city) = lower(${p(str(q.city, 60))})`);
  }
  const from = Number(q.from) || now() - 6 * 3600000;
  const to = Number(q.to) || now() + 120 * 86400000;
  where.push(`COALESCE(e.ends_at, e.starts_at + 6 * 3600000) >= ${p(from)} AND e.starts_at <= ${p(to)}`);
  if (CATEGORIES.includes(q.category)) where.push(`e.category = ${p(q.category)}`);
  if (q.source === 'noktura') where.push("e.source = 'noktura'");
  else if (q.source === 'web') where.push("e.source <> 'noktura'");
  const term = str(q.q, 80).toLowerCase().replace(/[%_\\]/g, m => '\\' + m);
  if (term) where.push(`(lower(e.title) LIKE ${p('%' + term + '%')} OR lower(e.venue) LIKE $${params.length} OR lower(e.lineup) LIKE $${params.length} OR lower(e.genres) LIKE $${params.length})`);
  if (q.freeOnly === '1') where.push("(e.source = 'noktura' AND (SELECT MIN(price) FROM event_tiers t WHERE t.event_id = e.id) = 0 OR lower(e.price_text) IN ('free','0','€0','$0'))");
  if (q.friends === '1' && me) where.push(`EXISTS (SELECT 1 FROM event_rsvps fr JOIN friends a ON a.user_id = ${p(me)} AND a.friend_id = fr.user_id
    JOIN friends b ON b.user_id = fr.user_id AND b.friend_id = $${params.length} WHERE fr.event_id = e.id)`);
  return { where: where.join(' AND '), params, p };
}

const SELECT = me => `
  SELECT e.*, u.handle, u.avatar, u.is_verified, u.role,
    (SELECT MIN(t.price) FROM event_tiers t WHERE t.event_id = e.id) AS min_price,
    (SELECT SUM(t.capacity - t.sold) FROM event_tiers t WHERE t.event_id = e.id) AS remaining,
    (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id AND r.status = 'going') AS going,
    (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id AND r.status = 'interested') AS interested
    ${me ? `, (SELECT status FROM event_rsvps r WHERE r.event_id = e.id AND r.user_id = '${me.replace(/'/g, "''")}') AS my_rsvp,
      (SELECT array_agg(fu.handle) FROM (SELECT fu.handle FROM event_rsvps fr JOIN users fu ON fu.id = fr.user_id
         JOIN friends a ON a.user_id = '${me.replace(/'/g, "''")}' AND a.friend_id = fr.user_id
         JOIN friends b ON b.user_id = fr.user_id AND b.friend_id = '${me.replace(/'/g, "''")}'
         WHERE fr.event_id = e.id AND fr.status = 'going' LIMIT 5) fu) AS friends_going` : ''}
  FROM events e LEFT JOIN users u ON u.id = e.user_id`;
// User ids are server-generated ([a-z0-9_]) and quoted above; checked here too.
const safeId = id => (id && /^[\w-]+$/.test(id) ? id : null);

r.get('/events', optionalAuth, limit('events', 240, 60000), route(async (req, res) => {
  const me = safeId(req.user?.id);
  const q = req.query;
  const { where, params, p } = filters(q, me);
  const pageSize = int(q.limit, { min: 1, max: 100, fallback: 60 });
  const offset = int(q.offset, { min: 0, max: 5000, fallback: 0 });
  const countParams = [...params];
  const rows = await db.all(`${SELECT(me)} WHERE ${where} ORDER BY e.starts_at ASC, e.id LIMIT ${p(pageSize + 1)} OFFSET ${p(offset)}`, params);
  const total = offset ? null : (await db.one(`SELECT COUNT(*)::int AS n FROM events e WHERE ${where}`, countParams)).n;
  let featured = [];
  if (!offset && q.featured !== '0') {
    const f = filters(q, me);
    featured = await db.all(`${SELECT(me)} WHERE ${f.where} AND e.starts_at >= ${f.p(now() - 3 * 3600000)}
      ORDER BY (e.promoted_until IS NOT NULL AND e.promoted_until > ${f.p(now())}) DESC,
        ((SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id AND r.status = 'going') * 25 + e.external_going + CASE WHEN e.image_url <> '' OR e.image_upload IS NOT NULL THEN 40 ELSE 0 END) DESC,
        e.starts_at ASC LIMIT 8`, f.params);
  }
  // Keep imported listings for this place fresh (Ticketmaster etc.), in the background.
  const lat = Number(q.lat), lng = Number(q.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) sources.ensureFresh({ name: str(q.city, 60), lat, lng }).catch(() => {});
  res.json({ events: rows.slice(0, pageSize).map(e => eventOut(e)), featured: featured.map(e => eventOut(e)), total, hasMore: rows.length > pageSize, nextOffset: offset + pageSize });
}));

// Events I'm going to / interested in / organising.
r.get('/events/mine', requireAuth, route(async (req, res) => {
  const me = safeId(req.user.id);
  const going = await db.all(`${SELECT(me)} JOIN event_rsvps mr ON mr.event_id = e.id AND mr.user_id = $1
    WHERE e.status = 'published' AND COALESCE(e.ends_at, e.starts_at + 21600000) > $2 ORDER BY e.starts_at LIMIT 100`, [me, now() - 86400000]);
  const hosting = await db.all(`${SELECT(me)} WHERE e.user_id = $1 AND e.status <> 'removed' ORDER BY e.starts_at DESC LIMIT 100`, [me]);
  res.json({ going: going.map(e => eventOut(e)), hosting: hosting.map(e => eventOut(e)) });
}));

async function loadEvent(id, me) {
  const e = await db.one(`${SELECT(safeId(me))} WHERE e.id = $1`, [id]);
  if (!e || e.status === 'removed') throw httpError(404, 'This event is no longer listed.');
  return e;
}

r.get('/events/:id', optionalAuth, route(async (req, res) => {
  const me = req.user?.id;
  const e = await loadEvent(req.params.id, me);
  const owner = me && e.user_id === me;
  if (e.visibility !== 'public' && !owner && !(me && e.user_id && (await areFriends(me, e.user_id)))) throw httpError(404, 'This event is no longer listed.');
  const tiers = await db.all('SELECT * FROM event_tiers WHERE event_id = $1 ORDER BY sort, price', [e.id]);
  const goingPublic = await db.all(`SELECT u.handle, u.avatar, u.avatar_upload FROM event_rsvps r JOIN users u ON u.id = r.user_id
    WHERE r.event_id = $1 AND r.status = 'going' ORDER BY r.created_at DESC LIMIT 24`, [e.id]);
  const chat = await db.one('SELECT c.id, EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = $2) AS member, (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id)::int AS members FROM chats c WHERE c.slug = $1', ['event:' + e.id, me || '']);
  let stats = null;
  if (owner) {
    stats = await db.one(`SELECT COUNT(*)::int AS tickets, COUNT(redeemed_at)::int AS checked_in, COALESCE(SUM(price_paid),0) AS gross
      FROM tickets WHERE event_id = $1 AND refunded_at IS NULL`, [e.id]);
    stats.gross = money(stats.gross);
  }
  const myTickets = me ? await db.one('SELECT COUNT(*)::int AS n FROM tickets WHERE event_id = $1 AND user_id = $2 AND refunded_at IS NULL', [e.id, me]) : null;
  res.json({
    event: eventOut(e, {
      mine: !!owner, feePct: PLATFORM_FEE_PCT,
      tiers: tiers.map(t => ({ id: t.id, name: t.name, price: money(t.price), remaining: t.capacity - t.sold, capacity: owner ? t.capacity : undefined, sold: owner ? t.sold : undefined, salesEnd: t.sales_end ? Number(t.sales_end) : null })),
      attendees: goingPublic.map(a => ({ handle: a.handle, avatar: a.avatar, avatarUrl: a.avatar_upload ? '/api/uploads/' + a.avatar_upload : '' })),
      chat: chat ? { id: chat.id, member: chat.member, members: chat.members } : null,
      stats, myTickets: myTickets ? myTickets.n : 0,
    }),
  });
}));

// ── create / edit / cancel ──────────────────────────────
function parseWhen(b, tz) {
  const startsAt = Number(b.startsAt) || zonedToEpoch(str(b.startsLocal, 20), tz);
  const endsAt = Number(b.endsAt) || (b.endsLocal ? zonedToEpoch(str(b.endsLocal, 20), tz) : null);
  if (!startsAt) throw httpError(400, 'Choose when the event starts.');
  if (startsAt < now() - 3600000) throw httpError(400, 'The start time is in the past.');
  if (startsAt > now() + 2 * 365 * 86400000) throw httpError(400, 'Events can be listed up to two years ahead.');
  if (endsAt && endsAt <= startsAt) throw httpError(400, 'The end time must be after the start.');
  if (endsAt && endsAt - startsAt > 14 * 86400000) throw httpError(400, 'Events can last up to 14 days.');
  return { startsAt, endsAt };
}
function parseTiers(list) {
  const tiers = (Array.isArray(list) && list.length ? list : [{ name: 'General admission', price: 0, capacity: 200 }]).slice(0, 8).map((t, i) => ({
    name: str(t.name, 40) || (i ? 'Tier ' + (i + 1) : 'General admission'),
    price: t.price === '' || t.price == null ? 0 : amountOf(t.price, { min: 0, max: 5000, label: 'price' }),
    capacity: int(t.capacity, { min: 1, max: 100000, fallback: 200 }),
  }));
  return tiers;
}

r.post('/events', requireAuth, limit('event-create', 20, 3600000), route(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 120);
  if (title.length < 3) throw httpError(400, 'Give the event a title.');
  const city = findCity(b.city);
  const tz = validZone(b.tz) ? b.tz : city?.tz || 'UTC';
  const { startsAt, endsAt } = parseWhen(b, tz);
  let lat = Number(b.lat), lng = Number(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    if (!city) throw httpError(400, 'Drop the venue on the map or choose a city.');
    lat = city.lat; lng = city.lng;
  }
  const tiers = parseTiers(b.tiers);
  const imageUpload = b.imageUpload && (await db.one("SELECT 1 FROM uploads WHERE id = $1 AND user_id = $2 AND content_type LIKE 'image/%'", [b.imageUpload, req.user.id])) ? b.imageUpload : null;
  const id = db.uid('ev');
  await db.tx(async c => {
    await c.query(`INSERT INTO events (id, user_id, source, title, description, venue, address, city, country, lat, lng, geo_precise, starts_at, ends_at, timezone,
        category, genres, lineup, image_upload, external_url, min_age, visibility, capacity, created_at, updated_at)
      VALUES ($1,$2,'noktura',$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22)`,
      [id, req.user.id, title, str(b.description, 4000), str(b.venue, 120), str(b.address, 200), city?.name || str(b.city, 60), city?.country || str(b.country, 2),
        lat, lng, startsAt, endsAt, tz, CATEGORIES.includes(b.category) ? b.category : 'club', str(b.genres, 120), str(b.lineup, 600), imageUpload,
        httpUrl(b.externalUrl), b.minAge ? int(b.minAge, { min: 0, max: 30 }) : null, b.visibility === 'friends' ? 'friends' : 'public',
        tiers.reduce((s, t) => s + t.capacity, 0), now()]);
    for (const [i, t] of tiers.entries()) {
      await c.query('INSERT INTO event_tiers (id, event_id, name, price, capacity, sort, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [db.uid('tier'), id, t.name, t.price, t.capacity, i, now()]);
    }
    await c.query("INSERT INTO event_rsvps (event_id, user_id, status, created_at) VALUES ($1,$2,'going',$3)", [id, req.user.id, now()]);
  });
  for (const fid of await rt.friendIds(req.user.id)) {
    if (await areFriends(req.user.id, fid)) await rt.notify(fid, 'event', { from: req.user.handle, eventId: id, message: `@${req.user.handle} is hosting ${title}.` });
  }
  rt.broadcast('events_changed', { id });
  res.status(201).json({ ok: true, id });
}));

async function ownEvent(req) {
  const e = await db.one('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (!e || e.status === 'removed') throw httpError(404, 'Event not found.');
  if (e.user_id !== req.user.id) throw httpError(403, 'Only the organiser can do that.');
  return e;
}

r.patch('/events/:id', requireAuth, route(async (req, res) => {
  const e = await ownEvent(req);
  const b = req.body || {};
  const sets = [], params = [e.id];
  const set = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (b.title !== undefined) { const t = str(b.title, 120); if (t.length < 3) throw httpError(400, 'Give the event a title.'); set('title', t); }
  for (const [k, col, max] of [['description', 'description', 4000], ['venue', 'venue', 120], ['address', 'address', 200], ['genres', 'genres', 120], ['lineup', 'lineup', 600]]) {
    if (b[k] !== undefined) set(col, str(b[k], max));
  }
  if (b.category !== undefined && CATEGORIES.includes(b.category)) set('category', b.category);
  if (b.externalUrl !== undefined) set('external_url', httpUrl(b.externalUrl));
  if (b.startsAt !== undefined || b.startsLocal !== undefined) { const w = parseWhen(b, e.timezone); set('starts_at', w.startsAt); set('ends_at', w.endsAt); }
  if (b.lat !== undefined && Number.isFinite(Number(b.lat)) && Number.isFinite(Number(b.lng))) { set('lat', Number(b.lat)); set('lng', Number(b.lng)); }
  if (b.imageUpload !== undefined) set('image_upload', b.imageUpload && (await db.one("SELECT 1 FROM uploads WHERE id = $1 AND user_id = $2 AND content_type LIKE 'image/%'", [b.imageUpload, req.user.id])) ? b.imageUpload : null);
  if (Array.isArray(b.addTiers)) {
    const count = await db.one('SELECT COUNT(*)::int AS n FROM event_tiers WHERE event_id = $1', [e.id]);
    for (const [i, t] of parseTiers(b.addTiers).slice(0, Math.max(0, 8 - count.n)).entries()) {
      await db.query('INSERT INTO event_tiers (id, event_id, name, price, capacity, sort, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [db.uid('tier'), e.id, t.name, t.price, t.capacity, count.n + i, now()]);
    }
  }
  if (Array.isArray(b.tierCapacity)) {
    for (const t of b.tierCapacity.slice(0, 8)) {
      const cap = int(t.capacity, { min: 1, max: 100000 });
      await db.query('UPDATE event_tiers SET capacity = GREATEST(sold, $3) WHERE id = $1 AND event_id = $2', [str(t.id, 40), e.id, cap]);
    }
  }
  set('updated_at', now());
  await db.query(`UPDATE events SET ${sets.join(', ')} WHERE id = $1`, params);
  rt.broadcast('events_changed', { id: e.id });
  res.json({ ok: true });
}));

// Cancelling refunds every ticket in full (face value from the organiser's
// balance, the service fee from NOKTURA) in one transaction.
r.delete('/events/:id', requireAuth, route(async (req, res) => {
  const e = await ownEvent(req);
  const refunded = await db.tx(async c => {
    await c.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [e.id]);
    const tickets = await db.all('SELECT * FROM tickets WHERE event_id = $1 AND refunded_at IS NULL AND (price_paid > 0 OR fee_paid > 0) FOR UPDATE', [e.id], c);
    const face = money(tickets.filter(t => t.user_id !== e.user_id).reduce((s, t) => s + money(t.price_paid), 0));
    if (face > 0) {
      await debit(c, e.user_id, face).catch(() => { throw httpError(400, `Refunds need ${face.toFixed(2)} NKT in your wallet. Top up, then cancel again.`); });
      await ledger(c, { fromId: e.user_id, fromLabel: req.user.handle, toLabel: 'Ticket buyers', amount: face, type: 'event_refund', note: 'Refunds: ' + e.title, ref: e.id });
    }
    for (const t of tickets) {
      const amount = money(money(t.price_paid) + money(t.fee_paid));
      if (amount > 0 && t.user_id !== e.user_id) {
        await credit(c, t.user_id, amount);
        await ledger(c, { toId: t.user_id, fromLabel: e.title, toLabel: 'buyer', amount, type: 'ticket_refund', note: 'Refund: ' + e.title, ref: t.id });
      }
    }
    await c.query('UPDATE tickets SET refunded_at = $2 WHERE event_id = $1 AND refunded_at IS NULL', [e.id, now()]);
    await c.query("UPDATE events SET status = 'cancelled', updated_at = $2 WHERE id = $1", [e.id, now()]);
    await c.query('DELETE FROM pins WHERE event_id = $1', [e.id]);
    return tickets;
  });
  const buyers = [...new Set(refunded.map(t => t.user_id))].filter(id => id !== e.user_id);
  for (const id of buyers) {
    await rt.notify(id, 'system', { eventId: e.id, message: `${e.title} was cancelled. Your tickets were refunded to your wallet.` });
    rt.toUser(id, 'wallet_update', { reason: 'refund' });
  }
  const going = await db.all("SELECT user_id FROM event_rsvps WHERE event_id = $1 AND user_id <> $2", [e.id, e.user_id]);
  for (const g of going) if (!buyers.includes(g.user_id)) await rt.notify(g.user_id, 'system', { eventId: e.id, message: `${e.title} was cancelled.` });
  rt.broadcast('events_changed', { id: e.id });
  res.json({ ok: true, refunded: refunded.length });
}));

// ── RSVP / attendees / event chat ─────────────────────────
r.post('/events/:id/rsvp', requireAuth, limit('rsvp', 120, 60000), route(async (req, res) => {
  const e = await loadEvent(req.params.id, req.user.id);
  const status = ['going', 'interested'].includes(req.body?.status) ? req.body.status : null;
  if (!status) await db.query('DELETE FROM event_rsvps WHERE event_id = $1 AND user_id = $2', [e.id, req.user.id]);
  else {
    const prev = await db.one('SELECT status FROM event_rsvps WHERE event_id = $1 AND user_id = $2', [e.id, req.user.id]);
    await db.query(`INSERT INTO event_rsvps (event_id, user_id, status, created_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT (event_id, user_id) DO UPDATE SET status = EXCLUDED.status`, [e.id, req.user.id, status, now()]);
    if (status === 'going' && prev?.status !== 'going') {
      if (e.user_id && e.user_id !== req.user.id) await rt.notify(e.user_id, 'rsvp', { from: req.user.handle, eventId: e.id, message: `@${req.user.handle} is going to ${e.title}.` });
    }
  }
  const counts = await db.one(`SELECT COUNT(*) FILTER (WHERE status = 'going')::int AS going, COUNT(*) FILTER (WHERE status = 'interested')::int AS interested FROM event_rsvps WHERE event_id = $1`, [e.id]);
  res.json({ ok: true, status, ...counts });
}));

r.post('/events/:id/chat', requireAuth, route(async (req, res) => {
  const e = await loadEvent(req.params.id, req.user.id);
  const slug = 'event:' + e.id;
  await db.query("INSERT INTO chats (id, type, name, slug, created_at) VALUES ($1,'event',$2,$3,$4) ON CONFLICT (slug) DO NOTHING", [db.uid('evc'), e.title.slice(0, 60), slug, now()]);
  const chat = await db.one('SELECT id FROM chats WHERE slug = $1', [slug]);
  const ins = await db.query('INSERT INTO chat_members (chat_id, user_id, last_read_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [chat.id, req.user.id, now()]);
  rt.joinUserToChat(req.user.id, chat.id);
  if (ins.rowCount) await rt.postMessage({ chatId: chat.id, user: null, text: `@${req.user.handle} joined`, kind: 'system' });
  res.json({ chatId: chat.id });
}));

// ── checkout ──────────────────────────────────────────
function ticketCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'NK' + Array.from(crypto.randomBytes(10), b => alphabet[b % alphabet.length]).join('');
}

// Locks the tier, checks it can sell `qty`, and reserves the seats.
async function reserve(c, eventId, tierId, qty) {
  const t = await db.one(`SELECT t.*, e.title, e.user_id AS organizer_id, e.starts_at, e.ends_at, e.status FROM event_tiers t JOIN events e ON e.id = t.event_id
    WHERE t.id = $1 AND t.event_id = $2 FOR UPDATE OF t`, [tierId, eventId], c);
  if (!t || t.status !== 'published') throw httpError(404, 'These tickets are no longer on sale.');
  if (Number(t.ends_at || Number(t.starts_at) + 6 * 3600000) < now()) throw httpError(400, 'This event has already finished.');
  if (t.sales_end && Number(t.sales_end) < now()) throw httpError(400, 'Sales for this tier have closed.');
  if (t.sold + qty > t.capacity) throw httpError(409, t.capacity - t.sold > 0 ? `Only ${t.capacity - t.sold} left in ${t.name}.` : `${t.name} is sold out.`, 'sold_out');
  await c.query('UPDATE event_tiers SET sold = sold + $2 WHERE id = $1', [t.id, qty]);
  await c.query('UPDATE events SET sold = sold + $2 WHERE id = $1', [eventId, qty]);
  return t;
}

async function issueTickets(c, { buyer, tier, qty, price, fee, orderId }) {
  const codes = [];
  for (let i = 0; i < qty; i++) {
    const code = ticketCode();
    codes.push(code);
    await c.query(`INSERT INTO tickets (id, user_id, event_id, tier_id, title, tier_name, code, price_paid, fee_paid, order_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [db.uid('tk'), buyer.id, tier.event_id, tier.id, tier.title, tier.name, code, price, fee, orderId, now()]);
  }
  await c.query(`INSERT INTO event_rsvps (event_id, user_id, status, created_at) VALUES ($1,$2,'going',$3)
    ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'going'`, [tier.event_id, buyer.id, now()]);
  return codes;
}

async function payOrganizer(c, { tier, buyer, gross, orderId }) {
  if (gross <= 0 || !tier.organizer_id || tier.organizer_id === buyer.id) return;
  const org = await db.one('SELECT id, handle, is_demo FROM users WHERE id = $1', [tier.organizer_id], c);
  if (!org || org.is_demo) return;
  await credit(c, org.id, gross);
  await ledger(c, { toId: org.id, fromLabel: buyer.handle, toLabel: org.handle, amount: gross, type: 'ticket_sale', note: `${tier.title} — ${tier.name}`, ref: orderId });
}

r.post('/events/:id/checkout', requireAuth, limit('checkout', 20, 60000), idempotent(async (req, res) => {
  const b = req.body || {};
  const qty = int(b.qty, { min: 1, max: 10, fallback: 1 });
  const method = ['wallet', 'paypal'].includes(b.method) ? b.method : 'wallet';
  const tierRow = await db.one('SELECT price FROM event_tiers WHERE id = $1 AND event_id = $2', [str(b.tierId, 40), req.params.id]);
  if (!tierRow) throw httpError(404, 'Choose a ticket type.');
  const price = money(tierRow.price);
  const fee = price > 0 ? feeOn(price) : 0;
  const gross = money(price * qty), total = money((price + fee) * qty);

  if (total === 0 || method === 'wallet') {
    const out = await db.tx(async c => {
      const tier = await reserve(c, req.params.id, str(b.tierId, 40), qty);
      const orderId = db.uid('ord');
      await c.query("INSERT INTO payment_orders (id, user_id, kind, provider, amount, items, status, created_at, captured_at) VALUES ($1,$2,'tickets',$3,$4,$5,'captured',$6,$6)",
        [orderId, req.user.id, total ? 'wallet' : 'free', total, JSON.stringify([{ eventId: req.params.id, tierId: tier.id, qty, price, fee }]), now()]);
      let balance = null;
      if (total > 0) {
        balance = await debit(c, req.user.id, total);
        await ledger(c, { fromId: req.user.id, fromLabel: req.user.handle, toLabel: tier.title, amount: total, type: 'ticket_purchase', note: `${qty}× ${tier.name}`, ref: orderId });
        await payOrganizer(c, { tier, buyer: req.user, gross, orderId });
      }
      const codes = await issueTickets(c, { buyer: req.user, tier, qty, price, fee, orderId });
      return { tier, codes, balance, orderId };
    });
    if (out.tier.organizer_id && out.tier.organizer_id !== req.user.id) {
      await rt.notify(out.tier.organizer_id, 'sale', { from: req.user.handle, eventId: req.params.id, message: `@${req.user.handle} got ${qty} × ${out.tier.name} for ${out.tier.title}.` });
      rt.toUser(out.tier.organizer_id, 'wallet_update', { reason: 'ticket_sale' });
    }
    return res.json({ ok: true, orderId: out.orderId, codes: out.codes, balance: out.balance, total });
  }

  // PayPal: create the order first (no money moves until the buyer approves
  // and we capture), then hold the seats for 20 minutes.
  const base = baseUrl(req);
  const { orderId, approveUrl } = await paypal.createOrder({ amount: total, description: `NOKTURA tickets ×${qty}`, returnUrl: base + '/paypal-return.html', cancelUrl: base + '/paypal-return.html?cancelled=1' });
  await db.tx(async c => {
    const tier = await reserve(c, req.params.id, str(b.tierId, 40), qty);
    await c.query("INSERT INTO payment_orders (id, user_id, kind, provider, amount, items, status, created_at, expires_at) VALUES ($1,$2,'tickets','paypal',$3,$4,'pending',$5,$6)",
      [orderId, req.user.id, total, JSON.stringify([{ eventId: req.params.id, tierId: tier.id, qty, price, fee }]), now(), now() + 20 * 60000]);
  });
  res.json({ ok: true, orderId, approveUrl, total, holdMinutes: 20 });
}));

r.post('/orders/:id/capture', requireAuth, limit('capture', 30, 60000), route(async (req, res) => {
  const order = await db.one("SELECT * FROM payment_orders WHERE id = $1 AND user_id = $2 AND kind = 'tickets'", [req.params.id, req.user.id]);
  if (!order) throw httpError(404, 'Order not found.');
  if (order.status === 'captured') {
    const t = await db.all('SELECT code FROM tickets WHERE order_id = $1', [order.id]);
    return res.json({ ok: true, codes: t.map(x => x.code), already: true });
  }
  const claimed = await db.one("UPDATE payment_orders SET status = 'capturing' WHERE id = $1 AND status = 'pending' AND expires_at > $2 RETURNING id", [order.id, now()]);
  if (!claimed) throw httpError(410, 'Your seat hold expired and you were not charged. Start checkout again.');
  let paid;
  try { paid = await paypal.captureOrder(order.id); }
  catch (e) { await db.query("UPDATE payment_orders SET status = 'pending' WHERE id = $1 AND status = 'capturing'", [order.id]); throw e; }
  if (paid + 0.01 < money(order.amount)) {
    await db.query("UPDATE payment_orders SET status = 'failed' WHERE id = $1", [order.id]);
    throw httpError(400, 'PayPal confirmed a different amount. Contact support with order ' + order.id + '.');
  }
  const [line] = order.items;
  const out = await db.tx(async c => {
    const tier = await db.one('SELECT t.*, e.title, e.user_id AS organizer_id FROM event_tiers t JOIN events e ON e.id = t.event_id WHERE t.id = $1', [line.tierId], c);
    await ledger(c, { fromLabel: 'PayPal', toLabel: tier.title, amount: money(order.amount), type: 'ticket_purchase_paypal', note: `${line.qty}× ${tier.name} for @${req.user.handle}`, ref: order.id });
    await payOrganizer(c, { tier, buyer: req.user, gross: money(line.price * line.qty), orderId: order.id });
    const codes = await issueTickets(c, { buyer: req.user, tier, qty: line.qty, price: line.price, fee: line.fee, orderId: order.id });
    await c.query("UPDATE payment_orders SET status = 'captured', captured_at = $2 WHERE id = $1", [order.id, now()]);
    return { tier, codes };
  });
  if (out.tier.organizer_id && out.tier.organizer_id !== req.user.id) {
    await rt.notify(out.tier.organizer_id, 'sale', { from: req.user.handle, eventId: line.eventId, message: `@${req.user.handle} got ${line.qty} × ${out.tier.name} for ${out.tier.title}.` });
    rt.toUser(out.tier.organizer_id, 'wallet_update', { reason: 'ticket_sale' });
  }
  res.json({ ok: true, codes: out.codes, eventId: line.eventId });
}));

// Releases seats held by PayPal orders that were never completed.
async function releaseExpiredHolds() {
  const stale = await db.all("SELECT id FROM payment_orders WHERE kind = 'tickets' AND status = 'pending' AND expires_at < $1 LIMIT 200", [now()]);
  for (const { id } of stale) {
    await db.tx(async c => {
      const o = await db.one("SELECT * FROM payment_orders WHERE id = $1 AND status = 'pending' FOR UPDATE", [id], c);
      if (!o) return;
      for (const l of o.items) {
        await c.query('UPDATE event_tiers SET sold = GREATEST(0, sold - $2) WHERE id = $1', [l.tierId, l.qty]);
        await c.query('UPDATE events SET sold = GREATEST(0, sold - $2) WHERE id = $1', [l.eventId, l.qty]);
      }
      await c.query("UPDATE payment_orders SET status = 'expired' WHERE id = $1", [id]);
    }).catch(e => console.error('[holds]', e.message));
  }
}
setInterval(() => releaseExpiredHolds().catch(() => {}), 60000).unref();

// ── tickets ───────────────────────────────────────────
const ticketOut = t => ({
  id: t.id, eventId: t.event_id, title: t.title, tier: t.tier_name, code: t.code, pricePaid: money(t.price_paid),
  redeemed: !!t.redeemed_at, redeemedAt: t.redeemed_at ? Number(t.redeemed_at) : null, refunded: !!t.refunded_at,
  venue: t.venue || '', city: t.city || '', startsAt: t.starts_at ? Number(t.starts_at) : null, image: t.image_upload ? '/api/uploads/' + t.image_upload : (t.image_url || ''),
  from: t.transferred_from || null, at: Number(t.created_at),
});
r.get('/tickets/mine', requireAuth, route(async (req, res) => {
  const rows = await db.all(`SELECT t.*, e.venue, e.city, e.starts_at, e.image_url, e.image_upload FROM tickets t LEFT JOIN events e ON e.id = t.event_id
    WHERE t.user_id = $1 ORDER BY COALESCE(e.starts_at, t.created_at) DESC LIMIT 300`, [req.user.id]);
  res.json({ tickets: rows.map(ticketOut) });
}));
r.post('/tickets/:id/transfer', requireAuth, limit('ticket-transfer', 20, 3600000), route(async (req, res) => {
  const to = await userByHandle(req.body?.toHandle);
  if (!to || to.is_demo) throw httpError(404, 'No one goes by that handle.');
  if (to.id === req.user.id) throw httpError(400, 'This ticket is already yours.');
  if (await rt.blockedBetween(req.user.id, to.id)) throw httpError(403, 'You can’t send tickets to this person.');
  const t = await db.tx(async c => {
    const t = await db.one('SELECT t.*, e.starts_at, e.ends_at FROM tickets t LEFT JOIN events e ON e.id = t.event_id WHERE t.id = $1 AND t.user_id = $2 FOR UPDATE OF t', [req.params.id, req.user.id], c);
    if (!t) throw httpError(404, 'Ticket not found.');
    if (t.redeemed_at) throw httpError(400, 'This ticket has already been scanned.');
    if (t.refunded_at) throw httpError(400, 'This ticket was refunded.');
    // A fresh code on every transfer, so screenshots of the old one stop working.
    await c.query('UPDATE tickets SET user_id = $2, transferred_from = $3, code = $4 WHERE id = $1', [t.id, to.id, req.user.handle, ticketCode()]);
    if (t.event_id) await c.query("INSERT INTO event_rsvps (event_id, user_id, status, created_at) VALUES ($1,$2,'going',$3) ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'going'", [t.event_id, to.id, now()]);
    return t;
  });
  await rt.notify(to.id, 'ticket', { from: req.user.handle, eventId: t.event_id, message: `@${req.user.handle} sent you a ticket for ${t.title}.` });
  res.json({ ok: true });
}));

// Guest list and door check-in for organisers.
r.get('/events/:id/guests', requireAuth, route(async (req, res) => {
  const e = await ownEvent(req);
  const rows = await db.all(`SELECT t.code, t.tier_name, t.redeemed_at, u.handle FROM tickets t JOIN users u ON u.id = t.user_id
    WHERE t.event_id = $1 AND t.refunded_at IS NULL ORDER BY u.handle LIMIT 20000`, [e.id]);
  res.json({ guests: rows.map(g => ({ code: g.code, tier: g.tier_name, handle: g.handle, checkedAt: g.redeemed_at ? Number(g.redeemed_at) : null })) });
}));
r.post('/tickets/verify', requireAuth, limit('scan', 240, 60000), route(async (req, res) => {
  const code = str(req.body?.code, 64).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) throw httpError(400, 'Scan or type a ticket code.');
  const t = await db.one(`SELECT t.*, u.handle, e.user_id AS organizer_id, e.title AS event_title FROM tickets t JOIN users u ON u.id = t.user_id
    LEFT JOIN events e ON e.id = t.event_id WHERE t.code = $1`, [code]);
  const scopedEvent = str(req.body?.eventId, 40);
  if (!t || t.organizer_id !== req.user.id || (scopedEvent && t.event_id !== scopedEvent)) return res.json({ status: 'not_found' });
  const guest = { code: t.code, handle: t.handle, tier: t.tier_name, event: t.event_title };
  if (t.refunded_at) return res.json({ status: 'refunded', ticket: guest });
  const upd = await db.one('UPDATE tickets SET redeemed_at = $2, redeemed_by = $3 WHERE id = $1 AND redeemed_at IS NULL RETURNING redeemed_at', [t.id, now(), req.user.id]);
  if (!upd) return res.json({ status: 'already', ticket: { ...guest, checkedAt: Number(t.redeemed_at) } });
  rt.toUser(t.user_id, 'ticket_scanned', { code: t.code, eventId: t.event_id });
  res.json({ status: 'ok', ticket: { ...guest, checkedAt: Number(upd.redeemed_at) } });
}));

module.exports = { router: r, eventOut, SELECT, safeId, CATEGORIES };

// Shared request helpers: validation, rate limiting, idempotency, time zones.
const db = require('./db');

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
const int = (v, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = min } = {}) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const money = db.money;
function amountOf(v, { min = 0.01, max = 10000, label = 'amount' } = {}) {
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n < min || n > max) throw httpError(400, `Enter an ${label} between ${min.toFixed(2)} and ${max.toFixed(2)}.`);
  return n;
}
function httpUrl(v, max = 500) {
  const s = str(v, max);
  if (!s) return '';
  if (!/^https?:\/\/[^\s]+$/i.test(s)) throw httpError(400, 'Links must start with http:// or https://');
  return s;
}
const handleOf = h => String(h || '').trim().replace(/^@/, '');

// ── Rate limiting ───────────────────────────────────────────────
// Sliding window per key, kept in memory. With several instances behind a
// load balancer each one enforces its own window, which is still a useful
// ceiling; put a shared limiter in front (Cloudflare, Render) for more.
const windows = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (windows.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { windows.set(key, arr); return false; }
  arr.push(now);
  windows.set(key, arr);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of windows) if (!v.length || now - v[v.length - 1] > 3600000) windows.delete(k);
}, 600000).unref();

// limit(name, n, ms) → middleware keyed by user id when signed in, else IP.
function limit(name, n, ms) {
  return (req, res, next) => {
    const who = req.user ? 'u:' + req.user.id : 'ip:' + req.ip;
    if (hit(name + ':' + who, n, ms)) return next();
    res.set('Retry-After', String(Math.ceil(ms / 1000)));
    res.status(429).json({ error: 'Too many requests. Slow down and try again shortly.' });
  };
}

// ── Idempotency ────────────────────────────────────────────────
// Money-moving endpoints accept an `Idempotency-Key` header. The first
// request with a key runs; repeats (double taps, retries after a dropped
// connection) get the stored response instead of charging twice.
function idempotent(handler) {
  return route(async (req, res, next) => {
    const key = str(req.get('Idempotency-Key'), 80);
    if (!key) return handler(req, res, next);
    if (!/^[\w-]{8,80}$/.test(key)) throw httpError(400, 'Invalid Idempotency-Key.');
    const claimed = await db.query('INSERT INTO idempotency_keys (user_id, key, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.user.id, key, Date.now()]);
    if (!claimed.rowCount) {
      const prev = await db.one('SELECT response FROM idempotency_keys WHERE user_id = $1 AND key = $2', [req.user.id, key]);
      if (prev?.response) return res.json(prev.response);
      throw httpError(409, 'This payment is already being processed.');
    }
    const json = res.json.bind(res);
    res.json = body => {
      const store = res.statusCode < 400
        ? db.query('UPDATE idempotency_keys SET response = $3 WHERE user_id = $1 AND key = $2', [req.user.id, key, JSON.stringify(body)])
        : db.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2', [req.user.id, key]);
      store.catch(e => console.error('[idempotency]', e.message));
      return json(body);
    };
    try { await handler(req, res, next); } catch (e) {
      await db.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2', [req.user.id, key]).catch(() => {});
      throw e;
    }
  });
}
setInterval(() => db.query('DELETE FROM idempotency_keys WHERE created_at < $1', [Date.now() - 2 * 86400000]).catch(() => {}), 3600000).unref();

// ── Time zones ─────────────────────────────────────────────────
// Converts a wall-clock time in an IANA zone ("2026-11-07T23:00") to epoch ms.
function zonedToEpoch(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || '');
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offset = zoneOffset(asUtc, tz);
  const first = asUtc - offset;
  // Re-check once: the offset can differ on the other side of a DST switch.
  const second = asUtc - zoneOffset(first, tz);
  return second;
}
function zoneOffset(epoch, tz) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(epoch)).map(p => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(epoch / 1000) * 1000;
  } catch { return 0; }
}
const validZone = tz => { if (typeof tz !== 'string' || !tz) return false; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

// Rough distance in km, good enough for "events near this city".
function km(aLat, aLng, bLat, bLng) {
  const toRad = x => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}
// Bounding box for a radius, used in SQL so indexes can help.
function bbox(lat, lng, radiusKm) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

module.exports = { httpError, route, str, int, money, amountOf, httpUrl, handleOf, limit, hit, idempotent, zonedToEpoch, validZone, km, bbox };

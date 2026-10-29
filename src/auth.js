const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { httpError, str, handleOf } = require('./lib');

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[noktura] JWT_SECRET must be set to at least 32 random characters in production.');
    process.exit(1);
  }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[noktura] JWT_SECRET is not set — using a temporary secret. Everyone is logged out on restart.');
}
const TOKEN_TTL = '30d';
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);
const RESERVED = new Set(['noktura', 'admin', 'support', 'system', 'anon', 'help', 'official', 'staff', 'moderator', 'root']);

function publicUser(u, { self = false } = {}) {
  const out = {
    id: u.id, handle: u.handle, displayName: u.display_name || '', avatar: u.avatar,
    avatarUrl: u.avatar_upload ? '/api/uploads/' + u.avatar_upload : '', city: u.city, bio: u.bio || '',
    verified: !!u.is_verified, official: u.role === 'official', createdAt: Number(u.created_at),
  };
  if (self) Object.assign(out, { balance: db.money(u.balance), cityLat: u.city_lat, cityLng: u.city_lng, role: u.role });
  return out;
}

function cleanAvatar(a, handle) {
  const s = String(a || '').trim();
  return s ? Array.from(s).slice(0, 2).join('').toUpperCase() : handle[0].toUpperCase();
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'Use a password of at least 8 characters.');
  if (password.length > 200) throw httpError(400, 'That password is too long.');
  if (/^(.)\1+$/.test(password) || ['password', '12345678', 'qwertyui', 'noktura1'].includes(password.toLowerCase())) throw httpError(400, 'Choose a less predictable password.');
}

async function signup(b) {
  const handle = handleOf(b.handle);
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(handle)) throw httpError(400, 'Handles are 3–20 characters: letters, numbers and underscores.');
  if (RESERVED.has(handle.toLowerCase())) throw httpError(409, 'That handle is reserved.');
  checkPassword(b.password);
  if (b.acceptTerms !== true) throw httpError(400, 'Accept the Terms and Privacy Policy to continue.');
  if (b.over18 !== true) throw httpError(400, 'You must be 18 or older to use NOKTURA.');

  const id = db.uid('u');
  const hash = await bcrypt.hash(b.password, 12);
  const lat = Number(b.cityLat), lng = Number(b.cityLng);
  try {
    await db.query(`INSERT INTO users (id, handle, password_hash, avatar, city, city_lat, city_lng, display_name, terms_accepted_at, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [id, handle, hash, cleanAvatar(b.avatar, handle), str(b.city, 60), Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null, str(b.displayName, 40), Date.now()]);
  } catch (e) {
    if (e.code === '23505') throw httpError(409, 'That handle is already taken.');
    throw e;
  }
  const user = await db.one('SELECT * FROM users WHERE id = $1', [id]);
  return { user: publicUser(user, { self: true }), token: issueToken(user) };
}

// Ten failed attempts per handle in 15 minutes locks that handle for the
// rest of the window. Stored in Postgres so every instance shares it.
async function login({ handle, password }, ip) {
  handle = handleOf(handle).toLowerCase().slice(0, 40);
  const since = Date.now() - 15 * 60000;
  const fails = await db.one('SELECT COUNT(*)::int AS n FROM login_failures WHERE key = $1 AND created_at > $2', ['h:' + handle, since]);
  if (fails.n >= 10) throw httpError(429, 'Too many failed attempts for this account. Try again in 15 minutes.');
  const user = await db.one('SELECT * FROM users WHERE lower(handle) = $1', [handle]);
  const ok = await bcrypt.compare(String(password || '').slice(0, 200), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || user.is_demo) {
    await db.query('INSERT INTO login_failures (key, created_at) VALUES ($1,$3),($2,$3)', ['h:' + handle, 'ip:' + ip, Date.now()]);
    throw httpError(401, 'Wrong handle or password.');
  }
  if (user.suspended_at) throw httpError(403, 'This account is suspended. Contact support@noktura.app.');
  await db.query('DELETE FROM login_failures WHERE key = $1', ['h:' + handle]);
  return { user: publicUser(user, { self: true }), token: issueToken(user) };
}
setInterval(() => db.query('DELETE FROM login_failures WHERE created_at < $1', [Date.now() - 86400000]).catch(() => {}), 3600000).unref();

function issueToken(user) {
  return jwt.sign({ sub: user.id, v: user.token_version || 0 }, JWT_SECRET, { expiresIn: TOKEN_TTL, algorithm: 'HS256' });
}
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

async function userFromToken(token) {
  const payload = verifyToken(token);
  const user = await db.one('SELECT * FROM users WHERE id = $1', [payload.sub]);
  if (!user || (payload.v || 0) !== (user.token_version || 0)) throw httpError(401, 'Your session ended. Log in again.');
  if (user.suspended_at) throw httpError(403, 'This account is suspended.');
  return user;
}

const bearer = req => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
};

async function requireAuth(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Log in to continue.' });
  try { req.user = await userFromToken(token); next(); }
  catch (e) { res.status(e.status === 403 ? 403 : 401).json({ error: e.status ? e.message : 'Your session expired. Log in again.' }); }
}
async function optionalAuth(req, res, next) {
  const token = bearer(req);
  if (token) { try { req.user = await userFromToken(token); } catch (_) { req.user = null; } }
  next();
}

async function verifyPassword(user, password) {
  const ok = await bcrypt.compare(String(password || '').slice(0, 200), user.password_hash);
  if (!ok) throw httpError(403, 'Your password was not correct.');
}

async function changePassword(user, current, next) {
  await verifyPassword(user, current);
  checkPassword(next);
  const hash = await bcrypt.hash(next, 12);
  const u = await db.one('UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING *', [user.id, hash]);
  return { token: issueToken(u) };
}

module.exports = { signup, login, verifyToken, userFromToken, requireAuth, optionalAuth, publicUser, cleanAvatar, issueToken, verifyPassword, changePassword };

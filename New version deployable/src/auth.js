const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[noktura] JWT_SECRET is not set — using a temporary secret. Everyone will be logged out on restart.');
}
const TOKEN_TTL = '30d';
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function publicUser(u) {
  return { id: u.id, handle: u.handle, avatar: u.avatar, city: u.city, balance: db.money(u.balance), createdAt: Number(u.created_at) };
}

function cleanHandle(h) { return String(h || '').trim().replace(/^@/, ''); }
function cleanAvatar(a, handle) {
  const s = String(a || '').trim();
  return s ? Array.from(s).slice(0, 2).join('') : handle[0].toUpperCase();
}

async function signup({ handle, password, city, avatar }) {
  handle = cleanHandle(handle);
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(handle)) throw httpError(400, 'Handle must be 3-20 characters: letters, numbers, underscore.');
  if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');
  if (password.length > 200) throw httpError(400, 'Password is too long.');
  if (await db.one('SELECT 1 FROM users WHERE lower(handle) = lower($1)', [handle])) throw httpError(409, 'That handle is already taken.');

  const id = db.uid('u');
  const hash = await bcrypt.hash(password, 12);
  try {
    await db.query('INSERT INTO users (id, handle, password_hash, avatar, city, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, handle, hash, cleanAvatar(avatar, handle), String(city || '').trim().slice(0, 60), Date.now()]);
  } catch (e) {
    if (e.code === '23505') throw httpError(409, 'That handle is already taken.');
    throw e;
  }
  const user = await db.one('SELECT * FROM users WHERE id = $1', [id]);
  return { user: publicUser(user), token: issueToken(user) };
}

async function login({ handle, password }) {
  handle = cleanHandle(handle);
  const user = await db.one('SELECT * FROM users WHERE lower(handle) = lower($1)', [handle]);
  // Compare against a dummy hash when the user is missing so timing doesn't reveal which handles exist.
  const ok = await bcrypt.compare(String(password || ''), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || user.is_demo) throw httpError(401, 'Invalid handle or password.');
  return { user: publicUser(user), token: issueToken(user) };
}

function issueToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  let payload;
  try { payload = verifyToken(token); } catch (e) { return res.status(401).json({ error: 'Your session expired. Please log in again.' }); }
  try {
    const user = await db.one('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
    req.user = user;
    next();
  } catch (e) { next(e); }
}

module.exports = { signup, login, verifyToken, requireAuth, publicUser, httpError, cleanAvatar };

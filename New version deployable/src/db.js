// PostgreSQL access layer. Works with Supabase (recommended) or Render Postgres.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('[noktura] DATABASE_URL is not set. Add your Supabase connection string (see README.md).');
  process.exit(1);
}

const useSsl = process.env.DATABASE_SSL !== 'false' && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DATABASE_POOL_SIZE || 8),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});
pool.on('error', e => console.error('[noktura] idle database client error:', e.message));

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('hex');
}

async function query(sql, params = [], client = pool) {
  return client.query(sql, params);
}
async function one(sql, params = [], client = pool) {
  const r = await client.query(sql, params);
  return r.rows[0] || null;
}
async function all(sql, params = [], client = pool) {
  const r = await client.query(sql, params);
  return r.rows;
}

// Runs fn(client) inside BEGIN/COMMIT, rolling back on any error.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    // Several instances may boot at once; only one applies the schema at a time.
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(sql);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(727001)'); } catch (_) {}
    client.release();
  }
}

const money = v => Math.round(Number(v || 0) * 100) / 100;

module.exports = { pool, uid, query, one, all, tx, migrate, money };

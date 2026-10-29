// `npm run migrate` — applies supabase/schema.sql and boot content, then exits.
require('dotenv').config();
const db = require('./db');
const { seed } = require('./seed');

(async () => {
  await db.migrate();
  await seed();
  console.log('[noktura] database is up to date');
  await db.pool.end();
})().catch(e => { console.error(e); process.exit(1); });

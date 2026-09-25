// `npm run migrate` — applies supabase/schema.sql (and demo data if enabled) then exits.
require('dotenv').config();
const db = require('./db');
const { seedDemoData } = require('./seed');

(async () => {
  await db.migrate();
  if (process.env.SEED_DEMO_DATA !== 'false') await seedDemoData();
  console.log('[noktura] database is up to date');
  await db.pool.end();
})().catch(e => { console.error(e); process.exit(1); });

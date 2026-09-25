// One-time demo network so a fresh deployment isn't empty. The app's own
// onboarding befriends @mia, @alex, @snake and @marko, and the map's
// "View event" button opens event ev_1 — both rely on this data.
// Demo accounts cannot log in (random password, is_demo = true).
// Disable with SEED_DEMO_DATA=false.
const crypto = require('crypto');
const db = require('./db');

function nextSaturdayText() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7));
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) + ' · 23:00';
}

async function seedDemoData() {
  const done = await db.one("SELECT value FROM app_meta WHERE key = 'demo_seeded'");
  if (done) return;
  const now = Date.now();
  const H = 3600000;

  await db.tx(async c => {
    const users = [
      ['u_demo_mia', 'mia', 'M', 'Belgrade'], ['u_demo_alex', 'alex', 'A', 'Berlin'],
      ['u_demo_snake', 'snake', 'S', 'London'], ['u_demo_marko', 'marko', 'M', 'Belgrade'],
    ];
    for (const [id, handle, avatar, city] of users) {
      await c.query(`INSERT INTO users (id, handle, password_hash, avatar, city, is_demo, created_at)
        VALUES ($1,$2,$3,$4,$5,TRUE,$6) ON CONFLICT DO NOTHING`,
        [id, handle, '!demo-' + crypto.randomBytes(16).toString('hex'), avatar, city, now - 40 * 24 * H]);
    }
    const pairs = [['mia', 'alex'], ['mia', 'snake'], ['mia', 'marko'], ['alex', 'snake']];
    for (const [a, b] of pairs) {
      await c.query('INSERT INTO friends VALUES ($1,$2,$3),($2,$1,$3) ON CONFLICT DO NOTHING', ['u_demo_' + a, 'u_demo_' + b, now]);
    }

    const posts = [
      ['post_demo_1', 'mia', false, 'Fabrika this weekend is going to be unreal. Who is coming? 🔥', 0.75],
      ['post_demo_2', 'alex', true, 'anyone got a spare ticket for Saturday?', 2],
      ['post_demo_3', 'snake', false, 'That afterparty last night was something else.', 5],
    ];
    for (const [id, who, anon, text, hoursAgo] of posts) {
      await c.query('INSERT INTO posts (id, user_id, anon, text, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [id, 'u_demo_' + who, anon, text, now - hoursAgo * H]);
    }
    await c.query("INSERT INTO post_likes VALUES ('post_demo_1','u_demo_snake'),('post_demo_1','u_demo_marko'),('post_demo_3','u_demo_mia') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO post_comments (id, post_id, user_id, text, created_at) VALUES
      ('c_demo_1','post_demo_1','u_demo_snake','already there',$1),
      ('c_demo_2','post_demo_1','u_demo_marko','saving a spot',$1),
      ('c_demo_3','post_demo_2','u_demo_mia','check the marketplace tab',$1) ON CONFLICT DO NOTHING`, [now - 0.5 * H]);

    await c.query(`INSERT INTO events (id, user_id, title, description, venue, date_text, price_usd, capacity, created_at)
      VALUES ('ev_1','u_demo_mia','Warehouse Night','Techno, good people, and a night worth staying up for. Bring ID.','Fabrika, Belgrade',$1,15,200,$2)
      ON CONFLICT DO NOTHING`, [nextSaturdayText(), now - 5 * H]);

    const pins = [
      ['pin_demo_event', 'mia', 'event', 'Warehouse Night', 'Fabrika · Belgrade', 'Techno, good people, and a night worth staying up for.', 44.8206, 20.4505, 15, 'public', 'ev_1', false],
      ['pin_demo_meet', 'snake', 'meetup', 'Pre-drinks at Kafeterija', 'The warm-up · Belgrade', 'Meet your crew before the doors open.', 44.8178, 20.4638, null, 'public', null, false],
      ['pin_demo_berlin', 'alex', 'event', 'Sunday Session', 'RAW-Gelände · Berlin', 'Open-air house and disco until late.', 52.5076, 13.4539, 12, 'public', null, false],
      ['pin_demo_london', 'snake', 'event', 'Basement Jungle', 'Hackney Wick · London', 'Drum & bass all night.', 51.5431, -0.0243, 18, 'public', null, false],
      ['pin_demo_mia_loc', 'mia', 'friend', '@mia', 'Sharing location', '', 44.8098, 20.4602, null, 'all_friends', null, true],
    ];
    for (const [id, who, type, title, subtitle, description, lat, lng, price, visibility, eventId, live] of pins) {
      await c.query(`INSERT INTO pins (id, user_id, type, title, subtitle, description, lat, lng, price_usd, visibility, event_id, is_live_location, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) ON CONFLICT DO NOTHING`,
        [id, 'u_demo_' + who, type, title, subtitle, description, lat, lng, price, visibility, eventId, live, now - H]);
    }

    // No demo marketplace listings or ads: NKT can be withdrawn as real money,
    // so only real users may fund ads or receive NKT from purchases.

    await c.query("INSERT INTO chats (id, type, name, slug, created_at) VALUES ('grp_noktura_general','group','Noktura general','general',$1) ON CONFLICT DO NOTHING", [now - 40 * 24 * H]);
    for (const [id] of users) await c.query("INSERT INTO chat_members (chat_id, user_id) VALUES ('grp_noktura_general',$1) ON CONFLICT DO NOTHING", [id]);
    await c.query("INSERT INTO messages (id, chat_id, from_user, text, created_at) VALUES ('m_demo_welcome','grp_noktura_general','mia','Welcome to Noktura! Say hi 👋',$1) ON CONFLICT DO NOTHING", [now - 10 * H]);

    await c.query("INSERT INTO app_meta (key, value) VALUES ('demo_seeded', $1) ON CONFLICT (key) DO NOTHING", [String(now)]);
  });
  console.log('[noktura] demo data seeded');
}

module.exports = { seedDemoData };

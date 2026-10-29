// Boot-time content: the @noktura account, imported listings for launch
// cities, city round-ups in the feed, community chats, and upgrades of rows
// written by the first release. Safe to run on every boot.
const crypto = require('crypto');
const db = require('./db');
const { zonedToEpoch } = require('./lib');
const { findCity } = require('./cities');
const { LISTINGS, VENUES } = require('./content/listings');

const SYSTEM_ID = 'u_noktura';
const LISTINGS_VERSION = '2026-10-29.3';
const hash = s => crypto.createHash('sha1').update(s).digest('hex');

// Deterministic spread around the city centre for venues without coordinates,
// so pins don't stack; the geocoder replaces these with real positions.
function estimate(city, venue) {
  const h = hash(city.name + '|' + venue);
  const angle = (parseInt(h.slice(0, 8), 16) / 0xffffffff) * Math.PI * 2;
  const dist = 0.4 + (parseInt(h.slice(8, 16), 16) / 0xffffffff) * 2.2; // km
  return [city.lat + (dist / 111) * Math.sin(angle), city.lng + (dist / (111 * Math.cos((city.lat * Math.PI) / 180))) * Math.cos(angle)];
}

async function ensureSystemUser(c) {
  await c.query(`INSERT INTO users (id, handle, password_hash, avatar, city, display_name, bio, is_demo, role, is_verified, created_at)
    VALUES ($1,'noktura',$2,'N','','NOKTURA','Nights worth leaving the house for. Listings from venues and promoters around the world.',TRUE,'official',TRUE,$3)
    ON CONFLICT (id) DO NOTHING`, [SYSTEM_ID, '!system-' + crypto.randomBytes(16).toString('hex'), Date.UTC(2026, 0, 1)]);
}

async function importListings(c) {
  let count = 0;
  for (const [cityName, rows] of Object.entries(LISTINGS)) {
    const city = findCity(cityName);
    const venues = VENUES[cityName] || {};
    for (const [title, venue, start, end, category, genres, lineup, price, url, image, sourceName] of rows) {
      const startsAt = zonedToEpoch(start, city.tz);
      const endsAt = end ? zonedToEpoch(end, city.tz) : null;
      const known = venues[venue];
      const [lat, lng] = known ? known : venue === cityName ? [city.lat, city.lng] : estimate(city, venue);
      const id = 'web_' + hash(url + '|' + start).slice(0, 16);
      await c.query(`INSERT INTO events (id, user_id, source, source_name, title, venue, address, city, country, lat, lng, geo_precise, starts_at, ends_at, timezone,
          category, genres, lineup, image_url, price_text, external_url, status, created_at, updated_at)
        VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'published',$21,$21)
        ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, venue = EXCLUDED.venue, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
          category = EXCLUDED.category, genres = EXCLUDED.genres, lineup = EXCLUDED.lineup, image_url = EXCLUDED.image_url,
          price_text = EXCLUDED.price_text, external_url = EXCLUDED.external_url, updated_at = EXCLUDED.updated_at`,
        [id, sourceName === 'Resident Advisor' ? 'ra' : 'web', sourceName, title, venue === cityName ? '' : venue, known?.[2] || '', city.name, city.country,
          lat, lng, venue === cityName, startsAt, endsAt, city.tz, category, genres, lineup, image, price, url, Date.now()]);
      count++;
    }
  }
  return count;
}

// City round-ups posted by @noktura, written from the imported listings.
const fmtDay = (ms, tz) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(ms);
async function writeRoundups(c) {
  const now = Date.now();
  const cities = Object.keys(LISTINGS);
  for (const [i, cityName] of cities.entries()) {
    const city = findCity(cityName);
    const upcoming = await db.all(`SELECT id, title, venue, starts_at, category, image_url FROM events
      WHERE lower(city) = lower($1) AND source <> 'noktura' AND status = 'published' AND starts_at > $2 ORDER BY starts_at LIMIT 400`, [city.name, now - 6 * 3600000], c);
    if (!upcoming.length) continue;
    const pick = (list, n) => list.slice(0, n).map(e => `${fmtDay(Number(e.starts_at), city.tz)} — ${e.title}${e.venue ? ', ' + e.venue : ''}`).join('\n');
    const week = upcoming.filter(e => Number(e.starts_at) < now + 7 * 86400000);
    const clubs = upcoming.filter(e => e.category === 'club');
    const live = upcoming.filter(e => e.category === 'concert');
    const posts = [];
    if (week.length) posts.push({ key: 'week', headline: `The week ahead in ${city.name}`, text: `${week.length} listings in the next seven days. A few to plan around:\n\n${pick(week, 6)}`, event: week.find(e => e.image_url) || week[0] });
    if (clubs.length >= 3) posts.push({ key: 'clubs', headline: `${city.name} after dark: club nights coming up`, text: pick(clubs, 6), event: clubs.find(e => e.image_url) || clubs[0] });
    if (live.length >= 3) posts.push({ key: 'live', headline: `Live in ${city.name}: concerts worth a ticket`, text: pick(live, 6), event: live.find(e => e.image_url) || live[0] });
    for (const [j, p] of posts.entries()) {
      const id = 'post_ed_' + hash(city.name + p.key).slice(0, 12);
      await c.query(`INSERT INTO posts (id, user_id, anon, kind, headline, text, city, event_id, image_url, created_at)
        VALUES ($1,$2,FALSE,'editorial',$3,$4,$5,$6,$7,$8)
        ON CONFLICT (id) DO UPDATE SET headline = EXCLUDED.headline, text = EXCLUDED.text, event_id = EXCLUDED.event_id, image_url = EXCLUDED.image_url`,
        [id, SYSTEM_ID, p.headline, p.text, city.name, p.event?.id || null, '', now - (i * 3 + j + 1) * 47 * 60000]);
    }
  }
}

// Short, factual venue notes for the two launch cities.
const GUIDES = [
  ['Belgrade', 'guide-clubs', 'Where Belgrade goes out', 'Drugstore runs long techno nights in the old city slaughterhouse on Bulevar despota Stefana. KC Grad, a converted warehouse in Savamala, books everything from house to post-punk. Karmakoma, Kult, Klub 20/44 on the Sava and the Dim complex in Cetinjska fill the rest of the week. Tap any venue on the map to see what is on there.'],
  ['Belgrade', 'guide-live', 'Big rooms and small stages', 'Sava Centar and Beogradska Arena take the large tours; MTS Dvorana in Dečanska and Bitef Art Cafe are the mid-size rooms; Zappa Baza, Zappa Barka and Elektropionir carry most rock and indie dates. Filter by Concert to see them in order.'],
  ['Novi Sad', 'guide-city', 'Novi Sad this season', 'SKCNS Fabrika in Kineska četvrt is the city’s main stage for rock and punk, Gerila Bar and K9 Station take the heavier bills, and Srpsko narodno pozorište and Galerija Matice srpske run theatre, talks and exhibitions all week. Everything here links back to the original listing.'],
];
async function writeGuides(c) {
  for (const [i, [cityName, key, headline, text]] of GUIDES.entries()) {
    const id = 'post_ed_' + hash(cityName + key).slice(0, 12);
    await c.query(`INSERT INTO posts (id, user_id, anon, kind, headline, text, city, created_at) VALUES ($1,$2,FALSE,'editorial',$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET headline = EXCLUDED.headline, text = EXCLUDED.text`, [id, SYSTEM_ID, headline, text, cityName, Date.now() - (30 + i * 90) * 60000]);
  }
}

// Rows from the first release: give old native events a ticket tier and
// fold the old external_events table into events.
async function upgradeLegacy(c) {
  await c.query(`INSERT INTO event_tiers (id, event_id, name, price, capacity, sold, created_at)
    SELECT 'tier_' || substr(md5(e.id), 1, 18), e.id, 'General admission', e.price_usd, GREATEST(e.capacity, e.sold, 1), e.sold, e.created_at
    FROM events e WHERE e.source = 'noktura' AND NOT EXISTS (SELECT 1 FROM event_tiers t WHERE t.event_id = e.id)
    ON CONFLICT (id) DO NOTHING`);
  await c.query(`UPDATE events SET starts_at = created_at + 86400000 WHERE starts_at IS NULL`);
  await c.query(`INSERT INTO events (id, source, source_name, title, venue, city, starts_at, price_text, external_url, image_url, status, created_at, updated_at)
    SELECT x.id, 'ticketmaster', 'Ticketmaster', x.title, x.venue, x.city, x.starts_at, x.price_text, x.url, x.image_url, 'published', x.fetched_at, x.fetched_at
    FROM external_events x WHERE x.starts_at IS NOT NULL ON CONFLICT (id) DO NOTHING`);
  await c.query(`UPDATE events e SET lat = 44.8125, lng = 20.4612 WHERE e.lat IS NULL AND lower(e.city) IN ('belgrade','beograd')`);
  await c.query('DELETE FROM external_events');
  for (const h of String(process.env.ADMIN_HANDLES || '').split(',').map(s => s.trim()).filter(Boolean)) {
    await c.query("UPDATE users SET role = 'admin' WHERE lower(handle) = lower($1) AND NOT is_demo", [h]);
  }
}

async function seed() {
  await db.tx(async c => {
    await ensureSystemUser(c);
    await upgradeLegacy(c);
    await c.query("INSERT INTO chats (id, type, name, slug, created_at) VALUES ('grp_noktura_general','group','NOKTURA — everyone','general',$1) ON CONFLICT DO NOTHING", [Date.UTC(2026, 0, 1)]);
    const v = await db.one("SELECT value FROM app_meta WHERE key = 'listings_version'", [], c);
    if (process.env.SEED_LISTINGS !== 'false' && v?.value !== LISTINGS_VERSION) {
      const n = await importListings(c);
      await writeRoundups(c);
      await writeGuides(c);
      await c.query("INSERT INTO app_meta (key, value) VALUES ('listings_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [LISTINGS_VERSION]);
      console.log(`[noktura] imported ${n} listings`);
    }
  });
}

module.exports = { seed, SYSTEM_ID };

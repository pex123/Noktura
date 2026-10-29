// External listings and geocoding.
//  · Ticketmaster Discovery (TICKETMASTER_API_KEY) — refreshed per place on
//    demand, at most every 6 hours, covering ~40 km around the coordinates.
//  · OpenStreetMap Nominatim — turns "venue, city" into coordinates for
//    imported rows; 1 request/second as the usage policy asks, cached forever.
const db = require('./db');
const { str, km } = require('./lib');

const TM_KEY = process.env.TICKETMASTER_API_KEY;
const CONTACT = process.env.CONTACT_EMAIL || 'hello@noktura.app';
const UA = `NOKTURA/2.0 (${CONTACT})`;
const inflight = new Set();

const TM_CATEGORY = { Music: 'concert', Sports: 'sport', 'Arts & Theatre': 'theatre', Film: 'film', Miscellaneous: 'other' };

async function ensureFresh(place) {
  if (!TM_KEY) return;
  const key = `tm:${place.lat.toFixed(1)},${place.lng.toFixed(1)}`;
  if (inflight.has(key)) return;
  const last = await db.one('SELECT synced_at FROM source_syncs WHERE key = $1', [key]);
  if (last && Date.now() - Number(last.synced_at) < 6 * 3600000) return;
  inflight.add(key);
  try {
    await db.query('INSERT INTO source_syncs (key, synced_at) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET synced_at = EXCLUDED.synced_at', [key, Date.now()]);
    await syncTicketmaster(place);
  } catch (e) {
    console.warn('[sources] ticketmaster', key, e.message);
    await db.query("UPDATE source_syncs SET status = 'error' WHERE key = $1", [key]).catch(() => {});
  } finally { inflight.delete(key); }
}

async function syncTicketmaster({ name, lat, lng }) {
  const start = new Date().toISOString().slice(0, 19) + 'Z';
  const end = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 19) + 'Z';
  for (let page = 0; page < 3; page++) {
    const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${encodeURIComponent(TM_KEY)}&latlong=${lat},${lng}&radius=40&unit=km`
      + `&startDateTime=${start}&endDateTime=${end}&size=100&page=${page}&sort=date,asc`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const list = data._embedded?.events || [];
    for (const e of list) {
      const v = e._embedded?.venues?.[0] || {};
      const vlat = Number(v.location?.latitude), vlng = Number(v.location?.longitude);
      const startsAt = e.dates?.start?.dateTime ? Date.parse(e.dates.start.dateTime) : null;
      if (!startsAt) continue;
      const pr = e.priceRanges?.[0];
      const seg = e.classifications?.[0]?.segment?.name;
      const genre = [e.classifications?.[0]?.genre?.name, e.classifications?.[0]?.subGenre?.name].filter(g => g && g !== 'Undefined').join(', ');
      const img = (e.images || []).filter(i => i.ratio === '16_9').sort((a, b) => b.width - a.width)[0]?.url || e.images?.[0]?.url || '';
      await db.query(`INSERT INTO events (id, source, source_name, title, venue, address, city, country, lat, lng, geo_precise, starts_at, timezone, category, genres,
          lineup, image_url, price_text, external_url, status, created_at, updated_at)
        VALUES ($1,'ticketmaster','Ticketmaster',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'published',$18,$18)
        ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, venue = EXCLUDED.venue, starts_at = EXCLUDED.starts_at, price_text = EXCLUDED.price_text,
          image_url = EXCLUDED.image_url, external_url = EXCLUDED.external_url, updated_at = EXCLUDED.updated_at`,
        ['tm_' + e.id, str(e.name, 200), str(v.name, 160), str(v.address?.line1, 200), str(v.city?.name || name, 60), str(v.country?.countryCode, 2),
          Number.isFinite(vlat) ? vlat : lat, Number.isFinite(vlng) ? vlng : lng, Number.isFinite(vlat), startsAt, str(e.dates?.timezone || v.timezone || 'UTC', 60),
          TM_CATEGORY[seg] || 'other', str(genre, 120), str((e._embedded?.attractions || []).map(a => a.name).join(', '), 600), img,
          pr ? `${pr.min}${pr.max && pr.max !== pr.min ? '–' + pr.max : ''} ${pr.currency}` : '', str(e.url, 500), Date.now()]);
    }
    if (page + 1 >= (data.page?.totalPages || 0)) break;
  }
}

// ── geocoding ──────────────────────────────────────────
async function geocode(query) {
  const q = query.trim().toLowerCase().slice(0, 200);
  const hit = await db.one('SELECT lat, lng FROM geocache WHERE query = $1', [q]);
  if (hit) return hit.lat == null ? null : { lat: hit.lat, lng: hit.lng };
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const [best] = await r.json();
  const out = best ? { lat: Number(best.lat), lng: Number(best.lon) } : null;
  await db.query('INSERT INTO geocache (query, lat, lng, label, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (query) DO NOTHING',
    [q, out?.lat ?? null, out?.lng ?? null, best?.display_name?.slice(0, 300) || '', Date.now()]);
  return out;
}

// Works through imported rows whose position is still an estimate.
let geoOffline = false;
async function refineOne() {
  if (geoOffline || process.env.GEOCODING === 'off') return false;
  const e = await db.one(`SELECT id, venue, address, city, lat, lng FROM events
    WHERE NOT geo_precise AND venue <> '' AND status = 'published' AND starts_at > $1 ORDER BY starts_at LIMIT 1`, [Date.now() - 86400000]);
  if (!e) return false;
  let pos = null;
  try { pos = await geocode([e.venue, e.address, e.city].filter(Boolean).join(', ')); }
  catch (err) { geoOffline = true; console.warn('[geocode] unavailable, keeping estimated venue positions:', err.message); return false; }
  // Accept only results near the listing's city, so namesakes elsewhere don't move pins abroad.
  if (pos && km(pos.lat, pos.lng, e.lat, e.lng) < 35) {
    await db.query('UPDATE events SET lat = $2, lng = $3, geo_precise = TRUE WHERE lower(venue) = lower($4) AND lower(city) = lower($5) AND NOT geo_precise', [e.id, pos.lat, pos.lng, e.venue, e.city]);
  } else {
    await db.query('UPDATE events SET geo_precise = TRUE WHERE lower(venue) = lower($1) AND lower(city) = lower($2) AND NOT geo_precise', [e.venue, e.city]);
  }
  return true;
}
function startGeocoder() {
  const tick = async () => {
    let more = false;
    try { more = await refineOne(); } catch (e) { console.warn('[geocode]', e.message); }
    setTimeout(tick, more ? 1100 : 10 * 60000).unref();
  };
  setTimeout(tick, 15000).unref();
}

module.exports = { ensureFresh, geocode, startGeocoder };

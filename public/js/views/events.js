import { state, api, qs, esc, icon, fTime, fDay, fDayNum, fWeekMonth, fDayLong, dayKey, zoneDayStart, isoDay, zonedToEpoch, plural, safeUrl, avatar, go, fail, currentQuery, on, CATEGORY_LABEL, $, $$, h, cityClock } from '../core.js';

const RANGES = [['tonight', 'Tonight'], ['tomorrow', 'Tomorrow'], ['weekend', 'Weekend'], ['week', 'This week'], ['month', 'This month'], ['all', 'Everything']];
const CATS = ['all', 'club', 'concert', 'festival', 'theatre', 'art', 'film', 'talk', 'sport'];

export function rangeFor(key, tz, date) {
  const now = Date.now();
  const today = zoneDayStart(now, tz);
  const H = 3600000, D = 86400000;
  switch (key) {
    case 'tonight': return { from: now - 3 * H, to: today + D + 6 * H, label: 'Tonight' };
    case 'tomorrow': return { from: today + D + 6 * H, to: today + 2 * D + 6 * H, label: 'Tomorrow' };
    case 'weekend': {
      const wd = new Date(today + 12 * H).toLocaleDateString('en-US', { weekday: 'short', timeZone: tz });
      const idx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd);
      const fri = today + (idx <= 4 ? 4 - idx : idx === 5 ? -1 : -2) * D;
      return { from: Math.max(now - 3 * H, fri + 17 * H), to: fri + 3 * D + 6 * H, label: 'This weekend' };
    }
    case 'week': return { from: now - 3 * H, to: today + 7 * D + 6 * H, label: 'Next 7 days' };
    case 'month': return { from: now - 3 * H, to: today + 31 * D, label: 'Next 30 days' };
    case 'date': { const s = zonedToEpoch(date + 'T06:00', tz); return { from: s, to: s + D, label: fDayLong(s + 12 * H, tz) }; }
    default: return { from: now - 3 * H, to: now + 180 * D, label: 'Everything coming up' };
  }
}

export function eventImg(e, cls = 'ph') {
  return e.image ? `<img src="${safeUrl(e.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ph="${esc(initials(e.title))}" data-phc="${cls}">` : `<div class="${cls}">${esc(initials(e.title))}</div>`;
}
const initials = t => String(t || '').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'N';

export function eventCard(e, { big } = {}) {
  const tz = e.tz || state.city.tz;
  return `<a class="ecard" href="#/e/${esc(e.id)}">
    <div class="ecard-img">${eventImg(e)}<div class="ecard-tag">${e.promoted ? '<span class="tag">Promoted</span>' : ''}${e.source === 'noktura' ? '<span class="tag line">On NOKTURA</span>' : ''}${e.soldOut ? '<span class="tag">Sold out</span>' : ''}</div></div>
    <div class="kicker"><b>${esc(fDay(e.startsAt, tz))}</b><span>${esc(fTime(e.startsAt, tz))}</span><span>${esc(CATEGORY_LABEL[e.category] || '')}</span></div>
    <div class="ecard-t">${esc(e.title)}</div>
    ${big && e.lineup && e.lineup !== e.title ? `<p class="muted" style="font-size:14px;margin-bottom:8px">${esc(e.lineup)}</p>` : ''}
    <div class="ecard-m"><span>${esc(e.venue || e.city)}</span><span class="price">${esc(e.priceText || '')}</span></div>
    ${going(e)}
  </a>`;
}
function going(e) {
  const fr = e.friendsGoing || [];
  if (!fr.length && !e.going) return '';
  return `<div class="going" style="margin-top:10px">${fr.length ? `<span class="av-stack">${fr.slice(0, 3).map(hd => `<span class="av sm">${esc(hd[0].toUpperCase())}</span>`).join('')}</span><span>${esc(fr.slice(0, 2).map(x => '@' + x).join(', '))}${fr.length > 2 ? ` +${fr.length - 2}` : ''} going</span>` : `<span>${plural(e.going, 'person', 'people')} going</span>`}</div>`;
}

function agendaRow(e) {
  const tz = e.tz || state.city.tz;
  const fr = e.friendsGoing || [];
  return `<a class="arow" href="#/e/${esc(e.id)}">
    <span class="t">${esc(fTime(e.startsAt, tz))}</span>
    <span class="thumb">${eventImg(e)}</span>
    <span><span class="ti">${esc(e.title)}</span><span class="sub"><span>${esc(e.venue || e.city)}</span><span>${esc(CATEGORY_LABEL[e.category] || '')}</span>${e.genres ? `<span>${esc(e.genres)}</span>` : ''}${fr.length ? `<span>${esc(fr.slice(0, 2).map(x => '@' + x).join(', '))} going</span>` : e.going ? `<span>${e.going} going</span>` : ''}</span></span>
    <span class="r"><span class="price">${esc(e.priceText || '—')}</span><span class="src">${esc(e.promoted ? 'Promoted' : e.sourceName)}</span></span>
  </a>`;
}

export async function eventsView(el) {
  const q = currentQuery();
  const city = state.city;
  const tz = city.tz;
  const f = { range: q.range || 'month', date: q.date || '', category: q.category || 'all', q: q.q || '', source: q.source || '', friends: q.friends || '' };
  const filtered = f.range !== 'month' || f.category !== 'all' || f.q || f.source || f.friends;
  const range = rangeFor(f.range, tz, f.date);
  let offset = 0, all = [], ctrl, total = 0;

  el.innerHTML = `
    <section class="hero" id="hero"><div class="hero-img" id="heroImg"></div><svg class="hero-mark" viewBox="34.9 32.1 79 79" aria-hidden="true"><path d="M72 33h11.6v11.7h-6.2L60.6 61.5v7.25H48.3V56.9zM78 46h12l22.8 22.8v12.5h-10.5V75l-17-17H78zM70.8 97.2h-12L36 74.4V61.9h10.5v6.3l17 17h7.3zM76.8 110.2H65.2V98.5h6.2l16.8-16.8v-7.25h12.3v11.85z"/></svg>
      <div class="wrap">
        <div class="hero-city">
          <div>
            <div class="kicker" style="color:rgba(255,255,255,.7);margin-bottom:22px">What’s on · ${esc(fDayLong(Date.now(), tz))}</div>
            <h1 class="h-mega">${esc(city.name)}</h1>
            <div class="hero-meta"><span><b>${esc(cityClock(tz))}</b> local time</span><span id="heroCount">&nbsp;</span><span id="heroFriends"></span></div>
          </div>
          <div class="hero-feature" id="heroFeature"></div>
        </div>
      </div>
    </section>
    <div class="rail"><div class="wrap">
      <div class="rail-in">
        ${RANGES.map(([k, l]) => `<button data-range="${k}" class="${f.range === k ? 'on' : ''}">${l}</button>`).join('')}
        <label class="${f.range === 'date' ? 'on' : ''}" style="${f.range === 'date' ? 'color:var(--fg)' : ''}">${icon('calendar', 'style="width:14px;height:14px"')}<span>${f.range === 'date' ? esc(fDay(range.from + 43200000, tz)) : 'Pick a date'}</span><input type="date" id="pickDate" value="${esc(f.date)}" min="${isoDay(Date.now(), tz)}"></label>
        <div class="rail-tools"><div class="search">${icon('search')}<input id="evq" placeholder="Artist, venue, genre" value="${esc(f.q)}" aria-label="Search events"></div></div>
      </div>
    </div></div>
    <div class="wrap">
      <div class="rail-sub">
        ${CATS.map(c => `<button class="chip ${f.category === c ? 'on' : ''}" data-cat="${c}">${c === 'all' ? 'All' : CATEGORY_LABEL[c]}</button>`).join('')}
        <span style="width:16px;flex:none"></span>
        <button class="chip ${f.friends ? 'on' : ''}" data-friends>Friends going</button>
        <button class="chip ${f.source === 'noktura' ? 'on' : ''}" data-src="noktura">On NOKTURA</button>
        <button class="chip ${f.source === 'web' ? 'on' : ''}" data-src="web">From the web</button>
        <a class="chip" href="#/create" style="margin-left:auto">+ Post an event</a>
      </div>
    </div>
    <section id="feat"></section>
    <section class="wrap" style="padding-top:40px">
      <div class="sec-h"><div><div class="label" style="margin-bottom:10px">${esc(range.label)}</div><div class="h-2">Agenda</div></div><span class="kicker" id="aCount"></span></div>
      <div id="agenda"><div class="empty">Loading events…</div></div>
      <div style="text-align:center;padding:32px 0" id="more" hidden><button class="btn">Load more</button></div>
    </section>
    <footer class="foot"><div class="wrap"><span>© ${new Date().getFullYear()} NOKTURA. Listings from venues, promoters and public calendars link to their original source.</span><nav><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refunds">Refunds</a><a href="/guidelines">Guidelines</a><a href="/organisers">For organisers</a></nav></div></footer>`;

  const setQ = patch => {
    const next = { ...f, ...patch };
    const s = qs({ range: next.range === 'month' ? '' : next.range, date: next.range === 'date' ? next.date : '', category: next.category === 'all' ? '' : next.category, q: next.q, source: next.source, friends: next.friends });
    go('/' + (s ? '?' + s : ''));
  };
  $$('[data-range]', el).forEach(b => (b.onclick = () => setQ({ range: b.dataset.range })));
  $('#pickDate', el).onchange = e => e.target.value && setQ({ range: 'date', date: e.target.value });
  $('label:has(#pickDate)', el)?.addEventListener('click', () => { try { $('#pickDate', el).showPicker(); } catch { /* older browsers open on focus */ } });
  $$('[data-cat]', el).forEach(b => (b.onclick = () => setQ({ category: b.dataset.cat })));
  $$('[data-src]', el).forEach(b => (b.onclick = () => setQ({ source: f.source === b.dataset.src ? '' : b.dataset.src })));
  $('[data-friends]', el).onclick = () => (state.user ? setQ({ friends: f.friends ? '' : '1' }) : go('/join?why=friends'));
  let st;
  $('#evq', el).oninput = e => { clearTimeout(st); st = setTimeout(() => setQ({ q: e.target.value.trim() }), 450); };
  if (f.q) { const i = $('#evq', el); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }

  async function load(more) {
    ctrl?.abort(); ctrl = new AbortController();
    const params = { lat: city.lat, lng: city.lng, city: city.name, from: range.from, to: range.to, category: f.category === 'all' ? '' : f.category, q: f.q, source: f.source, friends: f.friends, offset, limit: 60, featured: more ? '0' : '' };
    try {
      const r = await api('/api/events?' + qs(params), { signal: ctrl.signal });
      if (!more) { drawFeatured(r.featured, r.events); total = r.total; }
      all = more ? all.concat(r.events) : r.events;
      drawAgenda();
      $('#more', el).hidden = !r.hasMore;
      offset = r.nextOffset;
    } catch (e) { if (e.name !== 'AbortError') { $('#agenda', el).innerHTML = `<div class="empty"><div class="h-3">Couldn’t load events</div><p>${esc(e.message)}</p></div>`; } }
  }

  function drawFeatured(featured, events) {
    const lead = featured.find(x => x.image) || featured[0] || events[0];
    if (!lead?.image) $('#hero', el).classList.add('plain');
    if (lead) {
      if (lead.image) {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.alt = '';
        img.onload = () => { $('#heroImg', el)?.replaceChildren(img); $('#hero', el)?.classList.remove('plain'); };
        img.onerror = () => $('#hero', el)?.classList.add('plain');
        img.src = lead.image;
      }
      $('#heroFeature', el).innerHTML = `<div class="kicker">${lead.promoted ? 'Promoted · ' : 'Featured · '}${esc(fDay(lead.startsAt, lead.tz))} · ${esc(fTime(lead.startsAt, lead.tz))}</div>
        <div class="h-3">${esc(lead.title)}</div><p style="color:rgba(255,255,255,.72);font-size:14px;margin:-6px 0 18px">${esc(lead.venue || lead.city)}</p>
        <a class="btn" href="#/e/${esc(lead.id)}">${lead.source === 'noktura' ? 'Get tickets' : 'View event'}${icon('arrow')}</a>`;
    } else $('#heroFeature', el).innerHTML = '';
    const rest = filtered ? [] : featured.filter(x => x !== lead).slice(0, 7);
    $('#feat', el).innerHTML = rest.length >= 3 && (rest.length = rest.length >= 7 ? 7 : 3) ? `<div class="wrap" style="padding-top:48px"><div class="sec-h"><div><div class="label" style="margin-bottom:10px">Selected</div><div class="h-2">Worth leaving the house for</div></div></div></div>
      <div class="wrap" style="padding-top:0"><div class="grid-feature">${rest.map((e, i) => eventCard(e, { big: i === 0 })).join('')}</div></div>` : '';
  }

  function drawAgenda() {
    const box = $('#agenda', el);
    $('#aCount', el).textContent = total ? plural(total, 'event') : '';
    $('#heroCount', el).innerHTML = `<b>${total}</b> ${total === 1 ? 'event' : 'events'} · ${esc(range.label.toLowerCase())}`;
    const friendsOut = all.filter(e => e.friendsGoing?.length).length;
    if (friendsOut) $('#heroFriends', el).innerHTML = `<b>${friendsOut}</b> with friends going`;
    if (!all.length) {
      box.innerHTML = `<div class="empty"><div class="h-3">Nothing listed ${f.range === 'all' ? 'yet' : 'for ' + esc(range.label.toLowerCase())}</div>
        <p>Try a wider date range${f.category !== 'all' ? ' or another category' : ''} — or put your own night on the map.</p>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button class="btn" data-wider>See everything</button><a class="btn solid" href="#/create">Post an event</a></div></div>`;
      $('[data-wider]', box).onclick = () => setQ({ range: 'all', category: 'all', q: '', source: '', friends: '' });
      return;
    }
    const days = new Map();
    for (const e of all) {
      const tz2 = e.tz || tz;
      const k = dayKey(Math.max(e.startsAt, range.from), tz2);
      if (!days.has(k)) days.set(k, { ms: Math.max(e.startsAt, Date.now() - 3600000 * 3), tz: tz2, rows: [] });
      days.get(k).rows.push(e);
    }
    box.innerHTML = [...days.values()].map(d => `<div class="agenda-day"><div class="agenda-date"><div class="d">${esc(fDayNum(d.ms, d.tz))}</div><div class="w">${esc(fWeekMonth(d.ms, d.tz))}</div></div><div class="agenda-rows">${d.rows.map(agendaRow).join('')}</div></div>`).join('');
  }

  $('#more button', el).onclick = () => load(true);
  await load(false);
  const off = on('rt:events_changed', () => { offset = 0; load(false); });
  return () => { off(); ctrl?.abort(); };
}

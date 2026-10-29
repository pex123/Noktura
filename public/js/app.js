// NOKTURA — app frame: header, tab bar, city picker, notifications, routes.
import { state, api, on, emit, go, route, render, loadMe, setCity, setTheme, signOut, esc, icon, LOGO, modal, modalHead, toast, fail, cityClock, ago, avatar, $, $$, h, CFG } from './core.js';
import { eventsView } from './views/events.js';
import { eventView, createEventView } from './views/event.js';
import { mapView } from './views/map.js';
import { feedView } from './views/feed.js';
import { messagesView, startCallListeners } from './views/messages.js';
import { walletView, ticketsView, earnView } from './views/wallet.js';
import { marketView } from './views/market.js';
import { profileView, settingsView, friendsView, adminView } from './views/profile.js';
import { authView } from './views/auth.js';
import { doorView } from './views/door.js';

const NAV = [
  ['/', 'Events', 'calendar'],
  ['/map', 'Map', 'map'],
  ['/feed', 'Feed', 'feed'],
  ['/messages', 'Messages', 'chat'],
  ['/market', 'Market', 'bag'],
  ['/wallet', 'Wallet', 'wallet'],
];
const TABS = [['/', 'Events', 'calendar'], ['/map', 'Map', 'map'], ['/feed', 'Feed', 'feed'], ['/messages', 'Chat', 'chat'], ['/wallet', 'Wallet', 'wallet']];

function activeFor(path) {
  if (path === '/' || path.startsWith('/e/') || path === '/create') return '/';
  const top = '/' + (path.split('/')[1] || '');
  return top;
}

function renderHeader() {
  const path = (location.hash.slice(1) || '/').split('?')[0];
  const act = activeFor(path);
  const u = state.user;
  $('#hdr').innerHTML = `<div class="hdr-in">
    <a class="brand" href="#/" aria-label="NOKTURA home">${LOGO}<b>NOKTURA</b></a>
    <nav class="nav" aria-label="Primary">${NAV.map(([p, l]) => `<a href="#${p}" class="${act === p ? 'on' : ''}">${l}</a>`).join('')}</nav>
    <div class="hdr-r">
      <button class="city-btn" id="cityBtn" aria-label="Change city"><b>${esc(state.city.name)}</b><span class="num" id="cityClock">${cityClock(state.city.tz)}</span>${icon('chev')}</button>
      ${u ? `<button class="icon-btn" id="notifBtn" aria-label="Notifications">${icon('bell')}${state.unread.notifications ? `<span class="dot">${Math.min(99, state.unread.notifications)}</span>` : ''}</button>
        <a class="icon-btn hide-m" href="#/create" aria-label="Create event">${icon('plus')}</a>
        <a href="#/u/${esc(u.handle)}" aria-label="Your profile" style="margin-left:6px">${avatar(u)}</a>`
      : `<a class="btn sm ghost hide-m" href="#/login">Log in</a><a class="btn sm solid" href="#/join">Join</a>`}
    </div></div>`;
  $('#cityBtn').onclick = openCityPicker;
  const nb = $('#notifBtn');
  if (nb) nb.onclick = toggleNotifications;
  $('#tabbar').innerHTML = TABS.map(([p, l, i]) => `<a href="#${p}" class="${act === p ? 'on' : ''}">${icon(i)}<span>${l}</span>${p === '/messages' && state.unread.messages ? `<span class="dot">${Math.min(99, state.unread.messages)}</span>` : ''}</a>`).join('');
}
setInterval(() => { const c = document.getElementById('cityClock'); if (c) c.textContent = cityClock(state.city.tz); }, 15000);

// ── city picker ─────────────────────────────────────────
async function openCityPicker() {
  if (!state.cities.length) { try { state.cities = (await api('/api/cities')).cities; } catch (e) { fail(e); } }
  const m = modal(`${modalHead('Choose a city', 'Your region')}
    <div class="modal-b">
      <div class="search" style="border:1px solid var(--line-2);height:48px;padding:0 14px">${icon('search')}<input id="cq" placeholder="Search any city in the world" autocomplete="off"></div>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn sm ghost" id="locBtn">${icon('locate')}Use my location</button></div>
      <div class="city-list" id="cl"></div>
    </div>`);
  const list = m.el.querySelector('#cl');
  const draw = (items, remote) => {
    list.innerHTML = items.map((c, i) => `<button data-i="${i}" class="${c.name === state.city.name ? 'on' : ''}">${esc(c.name)}<span>${esc(remote ? c.region : c.country)}${c.tz && !remote ? ' · ' + cityClock(c.tz) : ''}</span></button>`).join('')
      || '<div class="empty">No matching places.</div>';
    $$('button', list).forEach(b => (b.onclick = async () => {
      const c = items[+b.dataset.i];
      choose(c);
      m.close();
    }));
  };
  const choose = async c => {
    setCity(c);
    toast(`Showing ${c.name}.`);
    if (state.user) api('/api/me', { method: 'PATCH', body: { city: c.name, cityLat: c.lat, cityLng: c.lng } }).then(r => { state.user = r.user; }).catch(() => {});
  };
  draw(state.cities);
  let t;
  m.el.querySelector('#cq').oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    clearTimeout(t);
    const local = state.cities.filter(c => c.name.toLowerCase().includes(q));
    draw(local);
    if (q.length >= 3 && local.length < 3) t = setTimeout(async () => {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=8&featuretype=city&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en' } });
        const res = await r.json();
        const remote = res.map(x => ({ name: x.address?.city || x.address?.town || x.address?.village || x.name, region: [x.address?.state, x.address?.country].filter(Boolean).join(', '), country: (x.address?.country_code || '').toUpperCase(), lat: +x.lat, lng: +x.lon, tz: guessTz(+x.lng) }));
        if (remote.length) draw([...local, ...remote.filter(x => !local.some(l => l.name === x.name))], true);
      } catch { /* offline search falls back to the list */ }
    }, 350);
  };
  m.el.querySelector('#locBtn').onclick = () => {
    if (!navigator.geolocation) return toast('Location isn’t available on this device.', 'err');
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      const near = [...state.cities].sort((a, b) => dist(a, lat, lng) - dist(b, lat, lng))[0];
      let c = near && dist(near, lat, lng) < 40 ? near : null;
      if (!c) {
        try {
          const r = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=${lat}&lon=${lng}`, { headers: { 'Accept-Language': 'en' } })).json();
          c = { name: r.address?.city || r.address?.town || r.address?.county || 'My area', country: (r.address?.country_code || '').toUpperCase(), lat, lng, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
        } catch { c = { name: 'My area', lat, lng, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }; }
      }
      choose(c); m.close();
    }, () => toast('Allow location access to use this.', 'err'), { timeout: 10000 });
  };
}
const dist = (c, lat, lng) => Math.hypot(c.lat - lat, (c.lng - lng) * Math.cos((lat * Math.PI) / 180)) * 111;
const guessTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// ── notifications ───────────────────────────────────────
let panel = null;
async function toggleNotifications() {
  if (panel) { panel.remove(); panel = null; return; }
  panel = h(`<aside class="panel" aria-label="Notifications"><div class="panel-h"><span class="label">Notifications</span><div style="display:flex;gap:6px"><button class="btn sm ghost" id="readAll">Mark all read</button><button class="icon-btn" id="closeN" aria-label="Close">${icon('x')}</button></div></div><div class="panel-l" id="nl"><div class="empty">Loading…</div></div></aside>`);
  document.body.appendChild(panel);
  panel.querySelector('#closeN').onclick = toggleNotifications;
  panel.querySelector('#readAll').onclick = async () => { await api('/api/notifications/read-all', { method: 'POST' }).catch(fail); state.unread.notifications = 0; emit('unread'); $$('.notif', panel).forEach(n => n.classList.remove('unread')); };
  try {
    const { notifications } = await api('/api/notifications');
    const l = panel.querySelector('#nl');
    l.innerHTML = notifications.length ? notifications.map(n => `<div class="notif ${n.read ? '' : 'unread'}" data-id="${esc(n.id)}"><div>${esc(n.payload?.message || describe(n))}<span>${ago(n.at)}</span></div></div>`).join('') : '<div class="empty">Nothing yet. Activity from friends, tickets and payments shows up here.</div>';
    $$('.notif', l).forEach((el, i) => (el.onclick = () => {
      const n = notifications[i];
      api(`/api/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
      if (!n.read) { state.unread.notifications = Math.max(0, state.unread.notifications - 1); emit('unread'); }
      const p = n.payload || {};
      toggleNotifications();
      if (p.chatId) go('/messages/' + p.chatId);
      else if (p.eventId) go('/e/' + p.eventId);
      else if (['payment', 'request', 'sale'].includes(n.type)) go('/wallet');
      else if (n.type.startsWith('friend')) go('/friends');
      else if (p.postId) go('/feed');
    }));
  } catch (e) { fail(e); }
}
const describe = n => (n.type === 'message' ? `@${n.payload.from}: ${n.payload.preview}` : n.type);

// ── unread chat badge ────────────────────────────────────
async function refreshUnread() {
  if (!state.user) return;
  try { const { chats } = await api('/api/chats'); state.unread.messages = chats.filter(c => !c.muted).reduce((s, c) => s + c.unread, 0); emit('unread'); } catch { /* offline */ }
}
on('rt:new_message', m => { if (state.user && m.from !== state.user.handle && !location.hash.startsWith('#/messages/' + m.chatId)) { state.unread.messages++; emit('unread'); } });
on('rt:wallet_update', d => { if (d?.reason === 'received') toast(`@${d.from} sent you ${Number(d.amount).toFixed(2)} NKT.`); });

// ── routes ───────────────────────────────────────────────
route('/', eventsView);
route('/events', eventsView);
route('/e/:id', eventView);
route('/e/:id/edit', (el, p, q) => createEventView(el, p, q));
route('/e/:id/door', doorView);
route('/create', createEventView);
route('/map', mapView);
route('/feed', feedView);
route('/messages', messagesView);
route('/messages/:id', messagesView);
route('/wallet', walletView);
route('/tickets', ticketsView);
route('/earn', earnView);
route('/market', marketView);
route('/u/:handle', profileView);
route('/friends', friendsView);
route('/settings', settingsView);
route('/admin', adminView);
route('/login', (el, p, q) => authView(el, 'login', q));
route('/join', (el, p, q) => authView(el, 'join', q));
route('/scan', doorView);

on('route', renderHeader);
on('auth', () => { renderHeader(); refreshUnread(); });
on('unread', renderHeader);
on('city', () => { renderHeader(); render(); });
on('theme', renderHeader);

(async () => {
  renderHeader();
  await loadMe();
  if (state.user?.city && !localStorage.getItem('nk_city')) {
    const c = state.user;
    if (c.cityLat != null) setCity({ name: c.city, lat: c.cityLat, lng: c.cityLng, tz: state.city.tz });
  }
  startCallListeners();
  render();
  refreshUnread();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
})();

window.NK = { state, setTheme, signOut, CFG };

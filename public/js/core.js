// NOKTURA client core: state, API, realtime, routing, formatting, UI primitives.
export const CFG = window.NOKTURA_CONFIG || {};

// ── storage ───────────────────────────────────────────────
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem('nk_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('nk_' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem('nk_' + k); } catch { /* ignore */ } },
};

// ── state & events ───────────────────────────────────────
const listeners = new Map();
export const on = (ev, fn) => { (listeners.get(ev) || listeners.set(ev, new Set()).get(ev)).add(fn); return () => listeners.get(ev).delete(fn); };
export const emit = (ev, data) => (listeners.get(ev) || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });

export const DEFAULT_CITY = { name: 'Belgrade', country: 'RS', lat: 44.8125, lng: 20.4612, tz: 'Europe/Belgrade' };
export const state = {
  token: store.get('token'),
  user: null,
  city: store.get('city') || DEFAULT_CITY,
  cities: [],
  unread: { messages: 0, notifications: 0 },
  theme: store.get('theme') || 'dark',
};
export function setCity(city) {
  state.city = { name: city.name, country: city.country || '', lat: +city.lat, lng: +city.lng, tz: city.tz || state.city.tz };
  store.set('city', state.city);
  emit('city', state.city);
}
export function setTheme(t) {
  state.theme = t;
  store.set('theme', t);
  document.documentElement.dataset.theme = t;
  emit('theme', t);
}
document.documentElement.dataset.theme = state.theme;

// ── API ─────────────────────────────────────────────────
export class ApiError extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

export async function api(path, { method = 'GET', body, idem, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  if (idem) headers['Idempotency-Key'] = idem === true ? newKey() : idem;
  let res;
  try { res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError('No connection. Check your network and try again.', 0); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token && !path.startsWith('/api/auth/')) { signOut(true); }
    throw new ApiError(data.error || `Request failed (${res.status}).`, res.status, data.code);
  }
  return data;
}
export const qs = obj => Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

export function setSession(token, user) {
  state.token = token; state.user = user;
  store.set('token', token);
  emit('auth', user);
  connectSocket();
}
export function signOut(expired) {
  state.token = null; state.user = null;
  store.del('token');
  if (socket) { socket.disconnect(); socket = null; }
  emit('auth', null);
  if (expired) toast('Your session ended. Log in again.', 'err');
}
export async function loadMe() {
  if (!state.token) return null;
  try {
    const r = await api('/api/me');
    state.user = r.user;
    state.unread.notifications = r.unreadNotifications;
    emit('auth', r.user); emit('unread');
    connectSocket();
    return r.user;
  } catch { return null; }
}
export const authed = () => !!state.user;
export function requireLogin(reason) {
  if (state.user) return true;
  go('/join' + (reason ? '?why=' + encodeURIComponent(reason) : '') + (reason ? '&' : '?') + 'next=' + encodeURIComponent(location.hash.slice(1) || '/'));
  return false;
}

// ── realtime ─────────────────────────────────────────────
export let socket = null;
function connectSocket() {
  if (socket || !state.token || !window.io) return;
  socket = window.io({ auth: { token: state.token }, transports: ['websocket', 'polling'] });
  const relay = ['new_message', 'message_deleted', 'typing', 'presence', 'notification', 'wallet_update', 'chat_created', 'new_post', 'post_deleted', 'new_comment',
    'pins_changed', 'events_changed', 'ticket_scanned', 'call_invite', 'call_signal', 'call_accept', 'call_reject', 'call_end', 'error_message'];
  relay.forEach(ev => socket.on(ev, d => emit('rt:' + ev, d)));
  socket.on('connect_error', e => { if (/log in/i.test(e.message)) signOut(true); });
  socket.on('notification', () => { state.unread.notifications++; emit('unread'); });
}

// Flyers hosted elsewhere can disappear or block hotlinking: swap in the placeholder.
document.addEventListener('error', e => {
  const img = e.target;
  if (img?.tagName !== 'IMG' || !img.dataset.ph) return;
  const ph = document.createElement('div');
  ph.className = img.dataset.phc || 'ph';
  ph.textContent = img.dataset.ph;
  img.replaceWith(ph);
}, true);

// PayPal's return page (opened in a popup) reports back here.
window.addEventListener('message', e => { if (e.origin === location.origin && e.data?.type === 'noktura:paypal') emit('paypal', e.data); });

// ── router ───────────────────────────────────────────────
const routes = [];
export const route = (pattern, view) => routes.push({ re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), view });
export const go = path => { if (location.hash.slice(1) !== path) location.hash = path; else render(); };
export const back = fallback => (history.length > 1 ? history.back() : go(fallback));
let current = { cleanup: null, path: null };
export function currentQuery() {
  const h = location.hash.slice(1) || '/';
  const i = h.indexOf('?');
  return Object.fromEntries(new URLSearchParams(i >= 0 ? h.slice(i + 1) : ''));
}
export async function render() {
  const hash = location.hash.slice(1) || '/';
  const [path] = hash.split('?');
  const main = document.getElementById('main');
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    if (current.cleanup) { try { current.cleanup(); } catch (e) { console.error(e); } }
    current = { cleanup: null, path };
    const el = document.createElement('div');
    el.className = 'view';
    main.replaceChildren(el);
    if (path !== current.lastPath) window.scrollTo(0, 0);
    current.lastPath = path;
    emit('route', path);
    try { current.cleanup = (await r.view(el, { ...(m.groups || {}) }, currentQuery())) || null; }
    catch (e) { console.error(e); el.innerHTML = errorBlock(e); }
    return;
  }
  main.innerHTML = `<div class="wrap empty"><div class="h-2">Not found</div><p>That page doesn’t exist.</p><a class="btn" href="#/">Back to events</a></div>`;
}
window.addEventListener('hashchange', render);

// ── formatting ───────────────────────────────────────────
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const attr = esc;
export const safeUrl = u => (/^(https?:\/\/|\/api\/uploads\/)/i.test(String(u || '')) ? esc(u) : '');
const fmtCache = new Map();
function fmt(opts, tz) {
  const key = JSON.stringify(opts) + tz;
  if (!fmtCache.has(key)) { try { fmtCache.set(key, new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz || undefined })); } catch { fmtCache.set(key, new Intl.DateTimeFormat('en-GB', opts)); } }
  return fmtCache.get(key);
}
export const fTime = (ms, tz) => fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, tz).format(ms);
export const fDay = (ms, tz) => fmt({ weekday: 'short', day: 'numeric', month: 'short' }, tz).format(ms);
export const fDayLong = (ms, tz) => fmt({ weekday: 'long', day: 'numeric', month: 'long' }, tz).format(ms);
export const fDate = (ms, tz) => fmt({ day: 'numeric', month: 'short', year: 'numeric' }, tz).format(ms);
export const fDayNum = (ms, tz) => fmt({ day: '2-digit' }, tz).format(ms);
export const fWeekMonth = (ms, tz) => fmt({ weekday: 'short' }, tz).format(ms) + ' · ' + fmt({ month: 'short' }, tz).format(ms);
export const dayKey = (ms, tz) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, tz).format(ms);
export function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 604800) return Math.floor(s / 86400) + 'd';
  return fDate(ms);
}
export const nkt = v => (Math.round(Number(v || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export function cityClock(tz) { try { return fTime(Date.now(), tz); } catch { return ''; } }
// Start/end of a calendar day in a time zone, as epoch ms.
function zoneOffset(epoch, tz) {
  const p = Object.fromEntries(fmt({ hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }, tz)
    .formatToParts(new Date(epoch)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(epoch / 1000) * 1000;
}
// Wall-clock "YYYY-MM-DDTHH:MM" in a zone → epoch ms (handles DST edges).
export function zonedToEpoch(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(local || '');
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  const first = asUtc - zoneOffset(asUtc, tz);
  return asUtc - zoneOffset(first, tz);
}
export function zoneDayStart(ms, tz) {
  const [d, mo, y] = dayKey(ms, tz).split('/');
  return zonedToEpoch(`${y}-${mo}-${d}T00:00`, tz);
}
export const isoDay = (ms, tz) => { const [d, mo, y] = dayKey(ms, tz).split('/'); return `${y}-${mo}-${d}`; };
export function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener nofollow ugc">$1</a>');
}

// ── UI primitives ────────────────────────────────────────
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

export function toast(msg, kind = 'ok', action) {
  const box = document.getElementById('toasts');
  const el = h(`<div class="toast ${kind === 'err' ? 'err' : ''}" role="status"><span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}</div>`);
  if (action) el.querySelector('button').onclick = () => { action.fn(); el.remove(); };
  box.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, kind === 'err' ? 5200 : 3200);
}
export const fail = e => { if (e?.name !== 'AbortError') toast(e?.message || 'Something went wrong.', 'err'); };

export function modal(html, { wide = false, onClose } = {}) {
  const bg = h(`<div class="modal-bg" role="dialog" aria-modal="true"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`);
  const close = () => { bg.remove(); document.removeEventListener('keydown', key); onClose && onClose(); };
  const key = e => { if (e.key === 'Escape') close(); };
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  bg.querySelectorAll('[data-close]').forEach(b => (b.onclick = close));
  document.addEventListener('keydown', key);
  document.body.appendChild(bg);
  const first = bg.querySelector('input,textarea,select');
  if (first && matchMedia('(pointer:fine)').matches) setTimeout(() => first.focus(), 50);
  return { el: bg.querySelector('.modal'), close };
}
export const modalHead = (title, kicker) => `<div class="modal-h"><div>${kicker ? `<div class="kicker" style="margin-bottom:10px">${esc(kicker)}</div>` : ''}<div class="h-3">${esc(title)}</div></div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>`;
export function confirmBox(title, body, okLabel = 'Confirm') {
  return new Promise(resolve => {
    const m = modal(`${modalHead(title)}<div class="modal-b"><p class="muted">${esc(body)}</p></div><div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" data-ok>${esc(okLabel)}</button></div>`, { onClose: () => resolve(false) });
    m.el.querySelector('[data-ok]').onclick = () => { resolve(true); m.close(); };
  });
}
export async function busy(btn, fn) {
  if (btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  try { return await fn(); } finally { btn.classList.remove('busy'); }
}
export function formData(form) {
  return Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
}
export function errorBlock(e) {
  return `<div class="wrap empty"><div class="h-3">Couldn’t load this</div><p>${esc(e?.message || 'Try again in a moment.')}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
}
export const avatar = (u, cls = '') => {
  const url = u?.avatarUrl;
  return `<span class="av ${cls}">${url ? `<img src="${safeUrl(url)}" alt="" loading="lazy">` : esc((u?.avatar || u?.handle || '?').slice(0, 2))}</span>`;
};

// File → base64 upload. Images are downscaled in the browser first.
export async function upload(file, purpose, chatId) {
  if (!file) return null;
  if (file.size > 25 * 1024 * 1024) throw new ApiError('Choose a file under 25 MB.');
  let blob = file, type = file.type || 'application/octet-stream';
  if (/^image\/(png|jpeg|webp)$/.test(type)) {
    try { blob = await shrink(file, purpose === 'avatar' ? 512 : 1800); type = blob.type; } catch { blob = file; }
  }
  if (blob.size > 8 * 1024 * 1024) throw new ApiError('Choose a file under 8 MB.');
  const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
  return api('/api/uploads', { method: 'POST', body: { filename: file.name, contentType: type, data, purpose, chatId } });
}
async function shrink(file, max) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 1.5e6) return file;
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(b => res(b || file), 'image/jpeg', 0.86));
}
export function pickFile(accept = 'image/*') {
  return new Promise(resolve => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept;
    i.onchange = () => resolve(i.files[0] || null);
    i.click();
  });
}

export function qrSvg(text) {
  if (!window.qrcode) return '';
  const q = window.qrcode(0, 'M');
  q.addData(text); q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
  return `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path d="${d}" fill="#000"/></svg>`;
}

export async function share(data) {
  if (navigator.share) { try { await navigator.share(data); return true; } catch { return false; } }
  try { await navigator.clipboard.writeText(data.url || data.text); toast('Link copied.'); return true; } catch { return false; }
}

// ── icons (24px, 1.5 stroke, square caps) ───────────────────
const I = {
  x: '<path d="M5 5l14 14M19 5L5 19"/>',
  menu: '<path d="M3 7h18M3 12h18M3 17h18"/>',
  search: '<path d="M10.5 4a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM15.5 15.5L21 21"/>',
  bell: '<path d="M6 17V11a6 6 0 1112 0v6l2 2H4zM10 21h4"/>',
  chat: '<path d="M4 4h16v12H9l-5 4z"/>',
  calendar: '<path d="M3 5h18v16H3zM3 10h18M8 2v5M16 2v5"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14"/>',
  feed: '<path d="M4 4h16v16H4zM4 9h16M9 9v11"/>',
  wallet: '<path d="M3 6h18v14H3zM3 10h18M16 15h2"/>',
  bag: '<path d="M5 8h14l-1 13H6zM9 8V5h6v3"/>',
  user: '<path d="M12 4a4 4 0 110 8 4 4 0 010-8zM4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowUpRight: '<path d="M7 17L17 7M8 7h9v9"/>',
  arrowDownLeft: '<path d="M17 7L7 17M16 17H7V8"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  send: '<path d="M3 11l18-8-8 18-2-8z"/>',
  heart: '<path d="M12 20s-8-5-8-11a4 4 0 018-1 4 4 0 018 1c0 6-8 11-8 11z"/>',
  comment: '<path d="M4 5h16v11H8l-4 4z"/>',
  share: '<path d="M12 3v13M7 8l5-5 5 5M4 14v7h16v-7"/>',
  image: '<path d="M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M15 8h.01"/>',
  ticket: '<path d="M3 6h18v4a2 2 0 000 4v4H3v-4a2 2 0 000-4zM14 6v12"/>',
  pin: '<path d="M12 21s-7-6.5-7-12a7 7 0 0114 0c0 5.5-7 12-7 12zM12 7v4M10 9h4"/>',
  locate: '<path d="M12 2v4M12 18v4M2 12h4M18 12h4M12 8a4 4 0 110 8 4 4 0 010-8z"/>',
  phone: '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 006 6L16 13l5 2v4a2 2 0 01-2 2A16 16 0 013 5a2 2 0 012-2z"/>',
  video: '<path d="M3 6h13v12H3zM16 10l5-3v10l-5-3"/>',
  mic: '<path d="M9 3h6v10H9zM5 11a7 7 0 0014 0M12 18v3"/>',
  paperclip: '<path d="M20 12l-8 8a5 5 0 01-7-7l9-9a3 3 0 014 4l-9 9a1 1 0 01-2-2l8-8"/>',
  qr: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3zM6 6h1v1H6zM17 6h1v1h-1zM6 17h1v1H6z"/>',
  scan: '<path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M3 12h18"/>',
  split: '<path d="M12 3v7M12 10L5 21M12 10l7 11"/>',
  request: '<path d="M12 21V8M7 13l5-5 5 5M4 3h16"/>',
  topup: '<path d="M12 5v14M5 12h14M3 3h18v18H3z"/>',
  withdraw: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  glass: '<path d="M6 3h12l-2 9a4 4 0 01-8 0zM12 16v5M8 21h8"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/>',
  flag: '<path d="M5 21V4h11l-1 4 4 4H5"/>',
  edit: '<path d="M4 20h4L20 8l-4-4L4 16zM13 7l4 4"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  star: '<path d="M12 3l2.7 6 6.3.6-4.8 4.2 1.4 6.2L12 17l-5.6 3 1.4-6.2L3 9.6 9.3 9z"/>',
  promote: '<path d="M4 20L20 4M9 4h11v11"/>',
  sun: '<path d="M12 7a5 5 0 110 10 5 5 0 010-10zM12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2"/>',
  moon: '<path d="M20 15A8 8 0 019 4a8 8 0 1011 11z"/>',
  logout: '<path d="M15 4h5v16h-5M10 8l-4 4 4 4M6 12h10"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4"/>',
  users: '<path d="M9 4a3.5 3.5 0 110 7 3.5 3.5 0 010-7zM2 20v-1a5 5 0 015-5h4a5 5 0 015 5v1M16 4a3.5 3.5 0 010 7M22 20v-1a5 5 0 00-4-4.9"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  steps: '<path d="M7 3c2 0 3 2 3 5s-1 5-3 5-3-2-3-5 1-5 3-5zM17 9c2 0 3 2 3 5s-1 5-3 5-3-2-3-5 1-5 3-5zM6 16h3v4H6zM16 21h3"/>',
  globe: '<path d="M12 3a9 9 0 110 18 9 9 0 010-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
};
export const icon = (n, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" ${extra}>${I[n] || ''}</svg>`;
export const LOGO = '<svg viewBox="34.9 32.1 79 79" aria-hidden="true"><path d="M72 33h11.6v11.7h-6.2L60.6 61.5v7.25H48.3V56.9zM78 46h12l22.8 22.8v12.5h-10.5V75l-17-17H78zM70.8 97.2h-12L36 74.4V61.9h10.5v6.3l17 17h7.3zM76.8 110.2H65.2V98.5h6.2l16.8-16.8v-7.25h12.3v11.85z"/></svg>';
export const VERIFIED = '<svg class="verified" viewBox="0 0 16 16" aria-label="Verified"><path d="M0 0h16v16H0z" fill="currentColor"/><path d="M4 8.2l2.6 2.6L12 5.4" stroke="var(--bg)" stroke-width="1.6" fill="none"/></svg>';

export const CATEGORY_LABEL = { club: 'Club', concert: 'Concert', festival: 'Festival', theatre: 'Theatre', art: 'Art', film: 'Film', talk: 'Talks', sport: 'Sport', food: 'Food & drink', other: 'Other' };

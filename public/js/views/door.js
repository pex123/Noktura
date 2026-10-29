import { state, api, esc, icon, fDay, fTime, go, fail, toast, $, $$ } from '../core.js';
import { needLogin } from './shared.js';

// Starts the camera on `video` and calls onCode(text) for each QR found.
// onCode returns true to stop scanning. Returns a stop function.
export function startScanner(video, onCode) {
  let stream, raf, stopped = false, last = '', lastAt = 0;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const stop = () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); };
  (async () => {
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
    catch { toast('Allow camera access to scan, or type the code.', 'err'); return; }
    if (stopped) return stop();
    video.srcObject = stream;
    await video.play().catch(() => {});
    const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    const tick = async () => {
      if (stopped) return;
      if (video.readyState >= 2) {
        let text = null;
        try {
          if (detector) { const r = await detector.detect(video); text = r[0]?.rawValue || null; }
          else if (window.jsQR) {
            const w = canvas.width = Math.min(640, video.videoWidth), hgt = canvas.height = Math.round(w * video.videoHeight / video.videoWidth);
            ctx.drawImage(video, 0, 0, w, hgt);
            text = window.jsQR(ctx.getImageData(0, 0, w, hgt).data, w, hgt, { inversionAttempts: 'dontInvert' })?.data || null;
          }
        } catch { /* keep scanning */ }
        if (text && (text !== last || Date.now() - lastAt > 2500)) {
          last = text; lastAt = Date.now();
          if (navigator.vibrate) navigator.vibrate(40);
          if (await onCode(text)) return stop();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  })();
  return stop;
}

export async function doorView(el, { id }) {
  if (!state.user) return needLogin('door');
  if (!id) {
    const { hosting } = await api('/api/events/mine').catch(e => (fail(e), { hosting: [] }));
    const up = hosting.filter(e => (e.endsAt || e.startsAt + 6 * 3600000) > Date.now() - 6 * 3600000 && e.status === 'published');
    el.innerHTML = `<div class="wrap"><div class="page-h"><div class="kicker">Organiser</div><h1 class="h-1">Door</h1></div>
      <div class="sec">${up.length ? up.map(e => `<a class="arow" href="#/e/${esc(e.id)}/door" style="grid-template-columns:120px 1fr auto"><span class="t">${esc(fDay(e.startsAt, e.tz))}</span><span class="ti">${esc(e.title)}</span><span class="link">Open${icon('arrow')}</span></a>`).join('')
        : '<div class="empty"><div class="h-3">No upcoming events</div><p>Post an event to sell tickets and scan them here.</p><a class="btn" href="#/create">Post an event</a></div>'}</div></div>`;
    return;
  }
  let e, guests = [], stop = null, filter = '';
  try { e = (await api('/api/events/' + id)).event; if (!e.mine) throw new Error('Only the organiser can open the door view.'); guests = (await api(`/api/events/${id}/guests`)).guests; }
  catch (err) { el.innerHTML = `<div class="wrap empty">${esc(err.message)}</div>`; return; }

  el.innerHTML = `<div class="wrap"><div class="page-h"><div class="kicker">Door · ${esc(fDay(e.startsAt, e.tz))} ${esc(fTime(e.startsAt, e.tz))}</div>
      <div class="page-h-row"><h1 class="h-2">${esc(e.title)}</h1><div class="prof" style="padding:0;border:0"><div class="stats" style="margin:0"><div><b class="num" id="cin">0</b>Checked in</div><div><b class="num" id="tot">0</b>Tickets</div></div></div></div></div>
    <div class="split" style="padding:32px 0 80px"><div>
      <div class="scan"><video playsinline muted></video><div class="frame"></div></div>
      <div id="res"></div>
      <form id="man" style="display:flex;gap:8px;margin-top:16px"><input class="input num" name="code" placeholder="Type a ticket code" autocomplete="off" style="text-transform:uppercase"><button class="btn solid">Check</button></form>
    </div><aside>
      <div class="label muted" style="margin-bottom:14px">Guest list</div>
      <input class="input" id="gq" placeholder="Search name or code" style="margin-bottom:12px">
      <div id="gl"></div>
    </aside></div></div>`;

  const drawGuests = () => {
    $('#cin', el).textContent = guests.filter(g => g.checkedAt).length;
    $('#tot', el).textContent = guests.length;
    const list = guests.filter(g => !filter || g.handle.toLowerCase().includes(filter) || g.code.toLowerCase().includes(filter));
    $('#gl', el).innerHTML = list.slice(0, 400).map(g => `<div class="list-row"><div class="t"><b>@${esc(g.handle)}</b><span class="num">${esc(g.code)} · ${esc(g.tier)}</span></div>${g.checkedAt ? `<span class="kicker">${esc(fTime(g.checkedAt))}</span>` : `<button class="btn sm ghost" data-in="${esc(g.code)}">Check in</button>`}</div>`).join('') || '<p class="muted">No tickets yet.</p>';
    $$('[data-in]', el).forEach(b => (b.onclick = () => verify(b.dataset.in)));
  };
  const show = (r) => {
    const box = $('#res', el);
    const t = r.ticket;
    const copy = { ok: ['Valid — let them in', `@${t?.handle} · ${t?.tier}`], already: ['Already scanned', t?.checkedAt ? `@${t.handle} came in at ${fTime(t.checkedAt)}` : ''], refunded: ['Refunded ticket', 'This ticket is no longer valid.'], not_found: ['Not a ticket for this event', 'Check the code or the event.'] }[r.status];
    box.innerHTML = `<div class="scan-res ${r.status === 'ok' ? 'ok' : ''}"><div class="h-2">${esc(copy[0])}</div><div>${esc(copy[1])}</div></div>`;
    if (navigator.vibrate) navigator.vibrate(r.status === 'ok' ? 60 : [80, 60, 80]);
  };
  async function verify(code) {
    try {
      const r = await api('/api/tickets/verify', { method: 'POST', body: { code, eventId: id } });
      show(r);
      if (r.status === 'ok') { const g = guests.find(x => x.code === r.ticket.code); if (g) g.checkedAt = r.ticket.checkedAt; drawGuests(); }
    } catch (err) { fail(err); }
  }
  $('#man', el).onsubmit = ev => { ev.preventDefault(); const c = ev.target.code.value.trim(); if (c) { verify(c); ev.target.code.value = ''; } };
  $('#gq', el).oninput = ev => { filter = ev.target.value.trim().toLowerCase(); drawGuests(); };
  drawGuests();
  stop = startScanner($('video', el), async text => { await verify(text.replace(/^noktura:ticket:/, '')); return false; });
  return () => stop?.();
}

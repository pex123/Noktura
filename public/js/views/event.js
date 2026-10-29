import { state, api, esc, icon, fTime, fDayLong, fDay, nkt, plural, safeUrl, avatar, go, fail, toast, modal, modalHead, busy, confirmBox, share, qrSvg, newKey, upload, pickFile, formData, zonedToEpoch, isoDay, linkify, CATEGORY_LABEL, CFG, $, $$, on } from '../core.js';
import { eventImg } from './events.js';
import { promoteModal, reportModal, moreMenu, needLogin } from './shared.js';

export async function eventView(el, { id }) {
  el.innerHTML = '<div class="wrap empty">Loading…</div>';
  let e;
  try { e = (await api('/api/events/' + encodeURIComponent(id))).event; }
  catch (err) { el.innerHTML = `<div class="wrap empty"><div class="h-2">Event not found</div><p>${esc(err.message)}</p><a class="btn" href="#/">Back to events</a></div>`; return; }
  const tz = e.tz || state.city.tz;
  const native = e.source === 'noktura';
  const ended = (e.endsAt || e.startsAt + 6 * 3600000) < Date.now();
  let tierId = e.tiers?.find(t => t.remaining > 0)?.id || null, qty = 1;

  const facts = [
    ['Date', `${fDayLong(e.startsAt, tz)}<span class="muted">${fTime(e.startsAt, tz)}${e.endsAt ? ' – ' + fTime(e.endsAt, tz) + (fDay(e.endsAt, tz) !== fDay(e.startsAt, tz) ? ' (' + fDay(e.endsAt, tz) + ')' : '') : ''} · ${esc(tz.split('/').pop().replace(/_/g, ' '))} time</span>`],
    ['Venue', `${esc(e.venue || e.city)}${e.address ? `<span class="muted">${esc(e.address)}${e.city ? ', ' + esc(e.city) : ''}</span>` : e.venue ? `<span class="muted">${esc(e.city)}</span>` : ''}`],
    e.genres ? ['Sound', esc(e.genres)] : null,
    ['Price', esc(e.priceText || (native ? 'Free' : 'See listing'))],
    e.minAge ? ['Entry', `${e.minAge}+ · bring ID`] : null,
    ['Listed by', native ? (e.by ? `<a href="#/u/${esc(e.by.handle)}">@${esc(e.by.handle)}</a>` : 'NOKTURA') : `${esc(e.sourceName)}<span class="muted">Tickets and changes on the original listing</span>`],
  ].filter(Boolean);

  el.innerHTML = `
    <div class="wrap" style="padding-top:20px;display:flex;justify-content:space-between;align-items:center;gap:12px">
      <a class="link" href="#/">${icon('back')}Events</a>
      <div style="display:flex;gap:4px">
        <button class="icon-btn" id="shareBtn" aria-label="Share">${icon('share')}</button>
        <button class="icon-btn" id="moreBtn" aria-label="More">${icon('more')}</button>
      </div>
    </div>
    <div class="wrap" style="margin-top:16px"><div class="ev-top" style="border-top:1px solid var(--line)">
      <div class="ev-flyer">${eventImg(e)}</div>
      <div class="ev-info">
        <div class="kicker"><b>${esc(CATEGORY_LABEL[e.category] || 'Event')}</b> · ${esc(e.city)}${e.promoted ? ' · Promoted' : ''}${e.status === 'cancelled' ? ' · <b>Cancelled</b>' : ''}</div>
        <h1 class="h-1">${esc(e.title)}</h1>
        <dl class="facts">${facts.map(([k, v]) => `<div class="fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
        <div class="rsvp">
          <button class="btn ${e.myRsvp === 'going' ? 'on' : ''}" data-rsvp="going">${icon('check')}Going <span class="num" id="gn">${e.going || ''}</span></button>
          <button class="btn ghost ${e.myRsvp === 'interested' ? 'on' : ''}" data-rsvp="interested">${icon('star')}Interested <span class="num" id="in">${e.interested || ''}</span></button>
        </div>
        <div id="buy"></div>
        ${e.friendsGoing?.length ? `<div class="going"><span class="av-stack">${e.friendsGoing.slice(0, 4).map(hd => `<span class="av sm">${esc(hd[0].toUpperCase())}</span>`).join('')}</span><span>${esc(e.friendsGoing.map(x => '@' + x).join(', '))} ${e.friendsGoing.length === 1 ? 'is' : 'are'} going</span></div>` : ''}
      </div>
    </div></div>
    <div class="wrap"><div class="ev-body">
      <div>
        ${e.lineup && e.lineup !== e.title ? `<div class="label muted" style="margin-bottom:16px">Line-up</div><div class="lineup">${e.lineup.split(/\s*,\s*/).filter(Boolean).map(a => `<span>${esc(a)}</span>`).join('')}</div>` : ''}
        ${e.description ? `<div class="label muted" style="margin:40px 0 16px">About</div><div class="prose">${e.description.split(/\n{2,}/).map(p => `<p>${linkify(p)}</p>`).join('')}</div>` : ''}
        ${!native ? `<div class="prose" style="margin-top:${e.lineup ? 40 : 0}px"><p>This listing comes from <b>${esc(e.sourceName)}</b>. Prices, set times and tickets are managed there — check the original page before you go.</p></div>
          <a class="btn" style="margin-top:24px" href="${safeUrl(e.externalUrl)}" target="_blank" rel="noopener">Open on ${esc(e.sourceName)}${icon('ext')}</a>` : ''}
        <div class="label muted" style="margin:48px 0 0">Location</div>
        <div class="mini-map" id="miniMap"></div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <a class="btn sm ghost" href="https://www.openstreetmap.org/?mlat=${e.lat}&mlon=${e.lng}#map=17/${e.lat}/${e.lng}" target="_blank" rel="noopener">Open map${icon('ext')}</a>
          <a class="btn sm ghost" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent((e.venue ? e.venue + ', ' : '') + e.city)}" target="_blank" rel="noopener">Directions${icon('ext')}</a>
        </div>
      </div>
      <aside>
        <div class="label muted" style="margin-bottom:16px">Who’s going</div>
        ${e.attendees?.length ? `<div class="people">${e.attendees.map(a => `<a href="#/u/${esc(a.handle)}" title="@${esc(a.handle)}">${avatar(a, 'md')}</a>`).join('')}</div><p class="muted" style="font-size:13px;margin-top:12px">${plural(e.going, 'person', 'people')} going${e.interested ? ` · ${e.interested} interested` : ''}</p>` : '<p class="muted">Be the first to say you’re going — your friends will see it.</p>'}
        <div class="label muted" style="margin:40px 0 16px">Event chat</div>
        <p class="muted" style="font-size:14px;margin-bottom:14px">${e.chat ? plural(e.chat.members, 'person', 'people') + ' in the chat.' : 'Find a crew, sort tickets, share a taxi.'}</p>
        <button class="btn block" id="chatBtn">${icon('chat')}${e.chat?.member ? 'Open chat' : 'Join the chat'}</button>
        <button class="btn block ghost" id="pinBtn" style="margin-top:8px">${icon('pin')}Show on map</button>
        <button class="btn block ghost" id="postBtn" style="margin-top:8px">${icon('feed')}Post about it</button>
        ${e.mine ? `<div class="label muted" style="margin:40px 0 16px">Organiser</div>
          ${e.stats ? `<div class="facts" style="margin-bottom:16px"><div class="fact"><dt>Tickets</dt><dd class="num">${e.stats.tickets}</dd></div><div class="fact"><dt>Checked in</dt><dd class="num">${e.stats.checked_in}</dd></div><div class="fact"><dt>Gross</dt><dd class="num">${nkt(e.stats.gross)} NKT</dd></div></div>` : ''}
          <a class="btn block solid" href="#/e/${esc(e.id)}/door">${icon('scan')}Door &amp; guest list</a>
          <a class="btn block ghost" style="margin-top:8px" href="#/e/${esc(e.id)}/edit">${icon('edit')}Edit event</a>
          <button class="btn block ghost" style="margin-top:8px" id="promoBtn">${icon('promote')}Promote</button>
          <button class="btn block ghost" style="margin-top:8px" id="cancelBtn">${icon('trash')}Cancel event</button>` : ''}
      </aside>
    </div></div>`;

  // ── buying ──
  const buy = $('#buy', el);
  function drawBuy() {
    if (!native) { buy.innerHTML = `<a class="btn block lg solid" href="${safeUrl(e.externalUrl)}" target="_blank" rel="noopener">Tickets on ${esc(e.sourceName)}${icon('ext')}</a>`; return; }
    if (e.status === 'cancelled') { buy.innerHTML = '<div class="err">This event was cancelled. Ticket holders were refunded to their wallets.</div>'; return; }
    if (ended) { buy.innerHTML = '<p class="muted">This event has finished.</p>'; return; }
    const tiers = e.tiers || [];
    const t = tiers.find(x => x.id === tierId);
    const fee = t && t.price > 0 ? Math.round(t.price * (e.feePct || 0)) / 100 : 0;
    const total = t ? Math.round((t.price + fee) * qty * 100) / 100 : 0;
    buy.innerHTML = `<div class="tiers">${tiers.map(x => `<div class="tier ${x.id === tierId ? 'on' : ''} ${x.remaining <= 0 ? 'out' : ''}" data-t="${esc(x.id)}">
        <span class="n">${esc(x.name)}</span><span class="p">${x.price ? nkt(x.price) : 'Free'}</span>
        <span class="muted">${x.remaining <= 0 ? 'Sold out' : x.remaining <= 25 ? `${x.remaining} left` : 'Available'}</span><span class="muted" style="text-align:right">${x.price ? 'NKT' : ''}</span></div>`).join('')}</div>
      ${t ? `<div style="display:flex;gap:8px;margin-top:12px"><div class="qty" style="width:150px"><button data-q="-1" aria-label="Fewer">−</button><span>${qty}</span><button data-q="1" aria-label="More">+</button></div>
        <button class="btn solid lg" style="flex:1" id="buyBtn">${t.price ? 'Buy · ' + nkt(total) + ' NKT' : 'Get free ticket'}</button></div>
        ${t.price ? `<p class="muted" style="font-size:12px;margin-top:10px">Includes ${nkt(fee * qty)} NKT service fee. Pay from your wallet${CFG.paypal ? ' or with PayPal / card' : ''}. Full refund if the organiser cancels.</p>` : ''}
        ${e.myTickets ? `<p style="font-size:13px;margin-top:10px">You have ${plural(e.myTickets, 'ticket')} — <a class="link" href="#/tickets">View</a></p>` : ''}` : ''}`;
    $$('[data-t]', buy).forEach(d => (d.onclick = () => { tierId = d.dataset.t; qty = 1; drawBuy(); }));
    $$('[data-q]', buy).forEach(b => (b.onclick = () => { qty = Math.max(1, Math.min(10, Math.min(t.remaining, qty + +b.dataset.q))); drawBuy(); }));
    const bb = $('#buyBtn', buy);
    if (bb) bb.onclick = () => (state.user ? checkout(e, t, qty, total) : needLogin('tickets'));
  }
  drawBuy();

  // ── RSVP ──
  $$('[data-rsvp]', el).forEach(b => (b.onclick = async () => {
    if (!state.user) return needLogin('rsvp');
    const next = e.myRsvp === b.dataset.rsvp ? null : b.dataset.rsvp;
    try {
      const r = await api(`/api/events/${e.id}/rsvp`, { method: 'POST', body: { status: next } });
      e.myRsvp = next; e.going = r.going; e.interested = r.interested;
      $$('[data-rsvp]', el).forEach(x => x.classList.toggle('on', x.dataset.rsvp === next));
      $('#gn', el).textContent = r.going || ''; $('#in', el).textContent = r.interested || '';
      if (next === 'going') toast('You’re going. Friends will see it.');
    } catch (err) { fail(err); }
  }));

  $('#shareBtn', el).onclick = () => share({ title: e.title, text: `${e.title} — ${fDay(e.startsAt, tz)}, ${e.venue || e.city}`, url: location.origin + '/#/e/' + e.id });
  $('#moreBtn', el).onclick = ev => moreMenu(ev.currentTarget, [
    { icon: 'calendar', label: 'Add to calendar', fn: () => downloadIcs(e) },
    { icon: 'share', label: 'Copy link', fn: () => navigator.clipboard.writeText(location.origin + '/#/e/' + e.id).then(() => toast('Link copied.')) },
    ...(e.mine ? [] : [{ icon: 'flag', label: 'Report', fn: () => (state.user ? reportModal('event', e.id) : needLogin('report')) }]),
  ]);
  $('#chatBtn', el).onclick = ev => {
    if (!state.user) return needLogin('chat');
    busy(ev.currentTarget, async () => { try { const r = await api(`/api/events/${e.id}/chat`, { method: 'POST' }); go('/messages/' + r.chatId); } catch (err) { fail(err); } });
  };
  $('#pinBtn', el).onclick = () => go(`/map?lat=${e.lat}&lng=${e.lng}&event=${e.id}`);
  $('#postBtn', el).onclick = () => (state.user ? go('/feed?event=' + e.id) : needLogin('post'));
  if (e.mine) {
    $('#promoBtn', el).onclick = () => promoteModal('event', e.id, () => eventView(el, { id }));
    $('#cancelBtn', el).onclick = async () => {
      const sold = e.stats?.tickets || 0;
      if (!(await confirmBox('Cancel this event?', sold ? `All ${sold} tickets will be refunded in full to buyers’ wallets. Face value comes from your balance.` : 'It will be removed from listings and everyone who RSVP’d is notified.', 'Cancel event'))) return;
      try { const r = await api('/api/events/' + e.id, { method: 'DELETE' }); toast(r.refunded ? `Cancelled. ${r.refunded} tickets refunded.` : 'Event cancelled.'); go('/'); }
      catch (err) { fail(err); }
    };
  }

  // ── mini map ──
  let map;
  if (window.L && Number.isFinite(e.lat)) {
    map = L.map($('#miniMap', el), { zoomControl: false, attributionControl: false, scrollWheelZoom: false, dragging: !L.Browser.mobile }).setView([e.lat, e.lng], 15);
    tiles().addTo(map);
    L.marker([e.lat, e.lng], { icon: L.divIcon({ className: '', html: '<div class="mk-pin ev">' + icon('pin', 'style="width:14px;height:14px"') + '</div>', iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(map);
  }
  const off = on('rt:ticket_scanned', d => { if (d.eventId === e.id) toast('Your ticket was scanned. Have a good night.'); });
  return () => { off(); map?.remove(); };
}

export function tiles() {
  const theme = state.theme === 'light' ? 'light' : 'dark';
  return L.tileLayer((CFG.tileUrl || '').replace('{theme}', theme), { attribution: CFG.tileAttribution, subdomains: 'abcd', maxZoom: 19, detectRetina: true });
}

async function checkout(e, t, qty, total) {
  let wallet = null;
  try { wallet = await api('/api/wallet'); } catch { /* handled below */ }
  const bal = wallet?.balance ?? 0;
  const key = newKey();
  const canWallet = !t.price || bal >= total;
  const m = modal(`${modalHead(e.title, 'Checkout')}
    <div class="modal-b">
      <div class="facts"><div class="fact"><dt>Ticket</dt><dd>${qty} × ${esc(t.name)}</dd></div><div class="fact"><dt>Date</dt><dd>${esc(fDayLong(e.startsAt, e.tz))}, ${esc(fTime(e.startsAt, e.tz))}</dd></div><div class="fact"><dt>Total</dt><dd class="num">${t.price ? nkt(total) + ' NKT' : 'Free'}</dd></div></div>
      ${t.price ? `<div class="seg" style="margin-top:20px" id="method"><button data-m="wallet" class="${canWallet ? 'on' : ''}">Wallet · ${nkt(bal)}</button>${CFG.paypal ? `<button data-m="paypal" class="${canWallet ? '' : 'on'}">PayPal / card</button>` : ''}</div>
        ${!canWallet ? `<p class="muted" style="font-size:13px;margin-top:12px">Your balance is short by ${nkt(total - bal)} NKT. ${CFG.paypal ? 'Pay with PayPal, or ' : ''}<a class="link" href="#/wallet?topup=1">top up</a>.</p>` : ''}` : ''}
      <p class="muted" style="font-size:12px;margin-top:16px">By buying you agree to the <a href="/terms" target="_blank" style="text-decoration:underline">Terms</a> and <a href="/refunds" target="_blank" style="text-decoration:underline">refund policy</a>. Tickets are QR codes in your wallet; each can be scanned once.</p>
    </div>
    <div class="modal-f"><button class="btn ghost" data-close>Back</button><button class="btn solid" id="pay">${t.price ? 'Pay ' + nkt(total) + ' NKT' : 'Confirm'}</button></div>`);
  let method = canWallet || !CFG.paypal ? 'wallet' : 'paypal';
  $$('[data-m]', m.el).forEach(b => (b.onclick = () => { method = b.dataset.m; $$('[data-m]', m.el).forEach(x => x.classList.toggle('on', x === b)); }));
  $('#pay', m.el).onclick = ev => busy(ev.currentTarget, async () => {
    try {
      if (method === 'paypal') {
        const popup = window.open('about:blank', 'paypal', 'width=480,height=720');
        const r = await api(`/api/events/${e.id}/checkout`, { method: 'POST', body: { tierId: t.id, qty, method: 'paypal' }, idem: key });
        if (popup) popup.location = r.approveUrl; else location.href = r.approveUrl;
        $('.modal-b', m.el).innerHTML = `<p class="lead">Approve the payment in the PayPal window, then come back here.</p><p class="muted" style="margin-top:12px">Your tickets are held for ${r.holdMinutes} minutes.</p>`;
        $('.modal-f', m.el).innerHTML = '<button class="btn solid block" id="fin">I’ve paid — get my tickets</button>';
        const finish = async () => {
          try { const c = await api(`/api/orders/${r.orderId}/capture`, { method: 'POST' }); off(); m.close(); showCodes(e, c.codes); }
          catch (err) { fail(err); }
        };
        const off = on('paypal', d => { if (d.status === 'approved') finish(); else { off(); toast('Payment cancelled. Nothing was charged.'); m.close(); } });
        $('#fin', m.el).onclick = ev2 => busy(ev2.currentTarget, finish);
        return;
      }
      const r = await api(`/api/events/${e.id}/checkout`, { method: 'POST', body: { tierId: t.id, qty, method: 'wallet' }, idem: key });
      if (state.user && r.balance != null) state.user.balance = r.balance;
      m.close(); showCodes(e, r.codes);
    } catch (err) {
      if (err.code === 'insufficient_funds') toast(err.message, 'err', { label: 'Top up', fn: () => { m.close(); go('/wallet?topup=1'); } });
      else fail(err);
    }
  });
}

function showCodes(e, codes) {
  const m = modal(`${modalHead(codes.length > 1 ? `${codes.length} tickets` : 'Your ticket', 'You’re in')}
    <div class="modal-b" style="text-align:center"><div class="qr">${qrSvg(codes[0])}</div><div class="code" style="margin-top:14px">${esc(codes[0])}</div>
      <p class="muted" style="margin-top:14px;font-size:14px">${esc(e.title)} · ${esc(fDay(e.startsAt, e.tz))}. All tickets are in your wallet, and you can send one to a friend from there.</p></div>
    <div class="modal-f"><button class="btn ghost" data-close>Close</button><a class="btn solid" href="#/tickets">My tickets</a></div>`);
  m.el.querySelector('a').onclick = () => m.close();
  eventView(document.querySelector('.view'), { id: e.id });
}

function downloadIcs(e) {
  const dt = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NOKTURA//EN', 'BEGIN:VEVENT', `UID:${e.id}@noktura`, `DTSTAMP:${dt(Date.now())}`, `DTSTART:${dt(e.startsAt)}`,
    `DTEND:${dt(e.endsAt || e.startsAt + 4 * 3600000)}`, `SUMMARY:${e.title.replace(/[,;\n]/g, ' ')}`, `LOCATION:${[e.venue, e.address, e.city].filter(Boolean).join(', ').replace(/[,;\n]/g, ' ')}`,
    `URL:${location.origin}/#/e/${e.id}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = 'noktura-event.ics'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── create / edit ───────────────────────────────────────
const CATS = ['club', 'concert', 'festival', 'theatre', 'art', 'film', 'talk', 'sport', 'food', 'other'];
export async function createEventView(el, { id } = {}) {
  if (!state.user) { needLogin('host'); return; }
  let e = null;
  if (id) { try { e = (await api('/api/events/' + id)).event; if (!e.mine) throw new Error('Only the organiser can edit this event.'); } catch (err) { el.innerHTML = `<div class="wrap empty">${esc(err.message)}</div>`; return; } }
  const city = state.city;
  const tz = e?.tz || city.tz;
  const local = ms => (ms ? isoDay(ms, tz) + 'T' + fTime(ms, tz) : '');
  let lat = e?.lat ?? city.lat, lng = e?.lng ?? city.lng, imageUpload, picked = !!e;
  const tiers = e ? [] : [{ name: 'Early bird', price: 10, capacity: 100 }, { name: 'General admission', price: 15, capacity: 400 }];

  el.innerHTML = `<div class="wrap"><div class="page-h"><div class="kicker">${e ? 'Edit event' : 'Host on NOKTURA'}</div><h1 class="h-1">${e ? esc(e.title) : 'Post an event'}</h1>
      ${e ? '' : '<p class="lead" style="margin-top:16px;max-width:620px">Sell tickets with QR check-in, get paid to your wallet the moment someone buys, and let people find it on the map.</p>'}</div>
    <form id="ef" class="split" style="padding:40px 0 80px" autocomplete="off">
      <div>
        <label class="field"><span>Title</span><input class="input" name="title" required maxlength="120" value="${esc(e?.title || '')}" placeholder="Name of the night"></label>
        <div class="row"><label class="field"><span>Starts</span><input class="input" type="datetime-local" name="startsLocal" required value="${esc(local(e?.startsAt))}"></label>
          <label class="field"><span>Ends</span><input class="input" type="datetime-local" name="endsLocal" value="${esc(local(e?.endsAt))}"></label></div>
        <p class="muted" style="font-size:12px;margin:-8px 0 18px">Times are in ${esc(tz.replace(/_/g, ' '))}.</p>
        <div class="row"><label class="field"><span>Venue</span><input class="input" name="venue" maxlength="120" value="${esc(e?.venue || '')}" placeholder="Club, bar, rooftop"></label>
          <label class="field"><span>Category</span><select class="select" name="category">${CATS.map(c => `<option value="${c}" ${(e?.category || 'club') === c ? 'selected' : ''}>${CATEGORY_LABEL[c]}</option>`).join('')}</select></label></div>
        <label class="field"><span>Address</span><input class="input" name="address" maxlength="200" value="${esc(e?.address || '')}" placeholder="Street and number"></label>
        <div class="field"><span>Exact spot — tap the map</span><div class="mini-map" id="pickMap" style="height:280px;margin:0"></div></div>
        <label class="field"><span>Line-up (comma separated)</span><input class="input" name="lineup" maxlength="600" value="${esc(e?.lineup || '')}" placeholder="Artist one, Artist two"></label>
        <label class="field"><span>Genres</span><input class="input" name="genres" maxlength="120" value="${esc(e?.genres || '')}" placeholder="Techno, House"></label>
        <label class="field"><span>Description</span><textarea class="textarea" name="description" maxlength="4000" placeholder="Door policy, set times, what to expect">${esc(e?.description || '')}</textarea></label>
        <div class="row"><label class="field"><span>Minimum age</span><input class="input" name="minAge" inputmode="numeric" value="${esc(e?.minAge || '18')}"></label>
          <label class="field"><span>External link (optional)</span><input class="input" name="externalUrl" maxlength="500" value="${esc(e?.externalUrl || '')}" placeholder="https://"></label></div>
      </div>
      <aside>
        <div class="field"><span>Flyer</span><button type="button" class="ev-flyer" id="flyer" style="width:100%;aspect-ratio:4/5;min-height:0;border:1px dashed var(--line-3);display:block">${e?.image ? `<img src="${safeUrl(e.image)}" alt="">` : `<div class="ph" style="font-size:14px;font-family:var(--f-display);letter-spacing:.2em;text-transform:uppercase">${icon('image', 'style="width:28px;height:28px;margin-bottom:12px"')}<br>Add flyer</div>`}</button></div>
        ${e ? `<div class="label muted" style="margin:28px 0 12px">Ticket tiers</div><div class="tiers">${e.tiers.map(t => `<div class="tier" style="cursor:default"><span class="n">${esc(t.name)}</span><span class="p">${t.price ? nkt(t.price) : 'Free'}</span><span class="muted">${t.sold} sold</span><span class="muted" style="text-align:right">cap <input data-cap="${esc(t.id)}" class="num" value="${t.capacity}" style="width:64px;border-bottom:1px solid var(--line-2);text-align:right"></span></div>`).join('')}</div>`
          : `<div class="label muted" style="margin:28px 0 12px">Tickets</div><div id="tierList"></div><button type="button" class="btn sm ghost" id="addTier" style="margin-top:8px">${icon('plus')}Add tier</button>
            <p class="muted" style="font-size:12px;margin-top:12px">Prices in NKT (1 NKT = 1 USD). Set 0 for free entry. Buyers pay a small service fee on top; you receive the full ticket price in your wallet.</p>
            <label class="check" style="margin-top:20px"><input type="checkbox" name="friendsOnly"> Friends only (hidden from public listings)</label>`}
        <button class="btn solid lg block" style="margin-top:28px" id="save">${e ? 'Save changes' : 'Publish event'}</button>
        <p class="muted" style="font-size:12px;margin-top:12px">By publishing you confirm you have the right to sell entry to this event and agree to the <a href="/organisers" target="_blank" style="text-decoration:underline">organiser terms</a>.</p>
      </aside>
    </form></div>`;

  const f = $('#ef', el);
  const drawTiers = () => {
    const list = $('#tierList', el);
    if (!list) return;
    list.innerHTML = tiers.map((t, i) => `<div class="row" style="gap:6px;margin-bottom:6px;align-items:center"><input class="input" data-k="name" data-i="${i}" value="${esc(t.name)}" placeholder="Tier name" style="flex:2">
      <input class="input num" data-k="price" data-i="${i}" value="${t.price}" inputmode="decimal" placeholder="Price" style="flex:1"><input class="input num" data-k="capacity" data-i="${i}" value="${t.capacity}" inputmode="numeric" placeholder="Qty" style="flex:1">
      <button type="button" class="icon-btn" data-rm="${i}" aria-label="Remove tier" style="flex:none">${icon('x')}</button></div>`).join('');
    $$('[data-k]', list).forEach(inp => (inp.oninput = () => { tiers[+inp.dataset.i][inp.dataset.k] = inp.value; }));
    $$('[data-rm]', list).forEach(b => (b.onclick = () => { tiers.splice(+b.dataset.rm, 1); if (!tiers.length) tiers.push({ name: 'General admission', price: 0, capacity: 200 }); drawTiers(); }));
  };
  drawTiers();
  const at = $('#addTier', el);
  if (at) at.onclick = () => { if (tiers.length < 8) { tiers.push({ name: '', price: '', capacity: 100 }); drawTiers(); } };

  $('#flyer', el).onclick = async () => {
    const file = await pickFile();
    if (!file) return;
    try { const r = await upload(file, 'event'); imageUpload = r.id; $('#flyer', el).innerHTML = `<img src="${safeUrl(r.url)}" alt="">`; } catch (err) { fail(err); }
  };

  let map;
  if (window.L) {
    map = L.map($('#pickMap', el), { attributionControl: false }).setView([lat, lng], picked ? 16 : 13);
    tiles().addTo(map);
    const mk = L.marker([lat, lng], { draggable: true, icon: L.divIcon({ className: '', html: '<div class="mk-pin ev">+</div>', iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(map);
    const set = ll => { lat = ll.lat; lng = ll.lng; picked = true; mk.setLatLng(ll); };
    map.on('click', ev => set(ev.latlng));
    mk.on('dragend', () => set(mk.getLatLng()));
  }

  $('#save', el).onclick = ev => {
    ev.preventDefault();
    if (!f.reportValidity()) return;
    busy(ev.currentTarget, async () => {
      const d = formData(f);
      const body = {
        title: d.title, venue: d.venue, address: d.address, category: d.category, lineup: d.lineup, genres: d.genres, description: d.description, externalUrl: d.externalUrl,
        startsAt: zonedToEpoch(d.startsLocal, tz), endsAt: d.endsLocal ? zonedToEpoch(d.endsLocal, tz) : undefined, lat, lng, city: city.name, tz,
        minAge: d.minAge || undefined,
      };
      if (imageUpload) body.imageUpload = imageUpload;
      try {
        if (e) {
          body.tierCapacity = $$('[data-cap]', el).map(i => ({ id: i.dataset.cap, capacity: i.value }));
          await api('/api/events/' + e.id, { method: 'PATCH', body });
          toast('Saved.'); go('/e/' + e.id);
        } else {
          if (!picked && !(await confirmLocation())) return;
          body.tiers = tiers.map(t => ({ name: t.name, price: t.price === '' ? 0 : t.price, capacity: t.capacity }));
          body.visibility = f.friendsOnly?.checked ? 'friends' : 'public';
          const r = await api('/api/events', { method: 'POST', body });
          toast('Published. Share it with your people.');
          go('/e/' + r.id);
        }
      } catch (err) { fail(err); }
    });
  };
  return () => map?.remove();
}
const confirmLocation = () => new Promise(res => {
  const m = modal(`${modalHead('Pin the venue?')}<div class="modal-b"><p class="muted">You haven’t placed the venue on the map. It will show at the city centre until you edit it.</p></div><div class="modal-f"><button class="btn ghost" data-close>Place it</button><button class="btn solid" id="ok">Publish anyway</button></div>`, { onClose: () => res(false) });
  m.el.querySelector('#ok').onclick = () => { res(true); m.close(); };
});

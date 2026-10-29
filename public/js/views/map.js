import { state, api, qs, esc, icon, fTime, fDay, safeUrl, go, fail, toast, modal, modalHead, busy, formData, ago, on, currentQuery, $, $$, CATEGORY_LABEL } from '../core.js';
import { tiles } from './event.js';
import { rangeFor } from './events.js';
import { promoteModal, reportModal, needLogin } from './shared.js';

let watchId = null, lastSent = 0;

export async function mapView(el) {
  if (!window.L) { el.innerHTML = '<div class="wrap empty">The map is still loading. Refresh in a moment.</div>'; return; }
  const q = currentQuery();
  const city = state.city;
  let filter = 'all', range = 'week', events = [], pins = [], dropMode = null, selected = q.event || null;

  el.innerHTML = `<div class="mapv">
    <aside class="map-panel">
      <div class="map-panel-h">
        <div class="kicker" style="margin-bottom:10px">${esc(city.name)} · map</div>
        <div class="seg" id="rng"><button data-r="tonight">Tonight</button><button data-r="week" class="on">7 days</button><button data-r="month">30 days</button></div>
        <div class="chips" style="margin-top:12px" id="flt">${[['all', 'All'], ['events', 'Events'], ['meetup', 'Meet-ups'], ['friends', 'Friends']].map(([k, l]) => `<button class="chip ${k === 'all' ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
      </div>
      <div class="map-list" id="ml"><div class="empty">Loading…</div></div>
    </aside>
    <div id="map">
      <div class="map-tools">
        <button class="btn sm" id="addEv">${icon('plus')}Event pin</button>
        <button class="btn sm" id="addMeet">${icon('users')}Meet-up</button>
        <button class="btn sm ${watchId != null ? 'on' : ''}" id="live">${icon('locate')}${watchId != null ? 'Sharing' : 'Share location'}</button>
      </div>
      <div class="map-hint" id="hint" hidden><span id="hintT"></span><button id="hintX">Cancel</button></div>
    </div>
  </div>`;

  const map = L.map($('#map', el), { zoomControl: true, worldCopyJump: true, minZoom: 2 }).setView([Number(q.lat) || city.lat, Number(q.lng) || city.lng], q.lat ? 16 : 13);
  map.zoomControl.setPosition('bottomright');
  tiles().addTo(map);
  const layer = L.layerGroup().addTo(map);

  const visible = () => [
    ...(filter === 'all' || filter === 'events' ? events.filter(e => Number.isFinite(e.lat)).map(e => ({ kind: 'ev', id: e.id, lat: e.lat, lng: e.lng, e, promoted: e.promoted })) : []),
    ...pins.filter(p => filter === 'all' || (filter === 'events' && p.type === 'event') || (filter === 'meetup' && p.type === 'meetup') || (filter === 'friends' && p.type === 'friend'))
      .map(p => ({ kind: p.type === 'friend' ? 'live' : p.type, id: p.id, lat: p.lat, lng: p.lng, p, promoted: p.promoted })),
  ];

  function markerHtml(it) {
    if (it.kind === 'ev') return `<div class="mk-pin ev ${it.promoted ? 'promo' : ''}">${esc((CATEGORY_LABEL[it.e.category] || 'E')[0])}</div>`;
    if (it.kind === 'live') return `<div class="mk-pin live">${esc((it.p.by || '?')[0].toUpperCase())}</div>`;
    return `<div class="mk-pin ${it.kind === 'event' ? 'ev' : ''} ${it.promoted ? 'promo' : ''}">${it.kind === 'meetup' ? '+' : '↗'}</div>`;
  }

  // Grid clustering: merges markers that would overlap at the current zoom.
  function draw() {
    layer.clearLayers();
    const items = visible();
    const z = map.getZoom();
    const cells = new Map();
    for (const it of items) {
      if (z >= 16 || it.kind === 'live') { cells.set(it.id, [it]); continue; }
      const pt = map.project([it.lat, it.lng], z);
      const k = Math.floor(pt.x / 56) + ':' + Math.floor(pt.y / 56);
      (cells.get(k) || cells.set(k, []).get(k)).push(it);
    }
    for (const group of cells.values()) {
      if (group.length === 1) {
        const it = group[0];
        const m = L.marker([it.lat, it.lng], { icon: L.divIcon({ className: '', html: markerHtml(it), iconSize: [30, 30], iconAnchor: [15, 15] }), draggable: !!it.p?.mine && it.kind !== 'live', keyboard: true, title: it.e?.title || it.p?.title })
          .addTo(layer).on('click', () => openItem(it, m));
        if (it.p?.mine) m.on('dragend', () => api('/api/pins/' + it.p.id, { method: 'PATCH', body: m.getLatLng() }).then(() => toast('Pin moved.')).catch(fail));
        if (it.id === selected) setTimeout(() => openItem(it, m), 200);
      } else {
        const lat = group.reduce((s, x) => s + x.lat, 0) / group.length, lng = group.reduce((s, x) => s + x.lng, 0) / group.length;
        L.marker([lat, lng], { icon: L.divIcon({ className: '', html: `<div class="mk-cluster">${group.length}</div>`, iconSize: [40, 40], iconAnchor: [20, 20] }) })
          .addTo(layer).on('click', () => map.flyTo([lat, lng], Math.min(17, z + 2), { duration: 0.5 }));
      }
    }
    drawList(items);
  }

  function drawList(items) {
    const ml = $('#ml', el);
    const sorted = [...items].sort((a, b) => (b.promoted - a.promoted) || ((a.e?.startsAt || a.p?.startsAt || 0) - (b.e?.startsAt || b.p?.startsAt || 0)));
    ml.innerHTML = sorted.length ? sorted.slice(0, 300).map(it => {
      if (it.kind === 'ev') return `<div class="map-item ev ${it.id === selected ? 'on' : ''}" data-id="${esc(it.id)}"><span class="mk">${esc((CATEGORY_LABEL[it.e.category] || 'E')[0])}</span><div><b>${esc(it.e.title)}</b><span>${esc(fDay(it.e.startsAt, it.e.tz))} ${esc(fTime(it.e.startsAt, it.e.tz))} · ${esc(it.e.venue || it.e.city)}</span></div><span class="kicker">${it.promoted ? 'AD' : ''}</span></div>`;
      const p = it.p;
      return `<div class="map-item ${p.type === 'event' ? 'ev' : ''} ${it.id === selected ? 'on' : ''}" data-id="${esc(it.id)}"><span class="mk">${p.type === 'friend' ? esc((p.by || '?')[0].toUpperCase()) : p.type === 'meetup' ? '+' : '↗'}</span><div><b>${esc(p.type === 'friend' ? '@' + p.by : p.title)}</b><span>${esc(p.type === 'friend' ? (p.subtitle || 'Out now') + ' · ' + ago(p.updatedAt) : (p.subtitle || '@' + p.by))}</span></div><span class="kicker">${p.mine ? 'YOU' : ''}</span></div>`;
    }).join('') : `<div class="empty" style="padding:40px 20px">Nothing on the map here yet.<br><br><button class="btn sm" id="emptyAdd">Drop a pin</button></div>`;
    $$('[data-id]', ml).forEach(d => (d.onclick = () => {
      const it = items.find(x => x.id === d.dataset.id);
      selected = it.id;
      map.flyTo([it.lat, it.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
      setTimeout(draw, 650);
    }));
    const ea = $('#emptyAdd', ml);
    if (ea) ea.onclick = () => startDrop('event');
  }

  function openItem(it, marker) {
    selected = it.id;
    let html;
    if (it.kind === 'ev') {
      const e = it.e;
      html = `<div class="pop"><div class="kicker">${esc(fDay(e.startsAt, e.tz))} · ${esc(fTime(e.startsAt, e.tz))}${e.promoted ? ' · Promoted' : ''}</div><div class="h-4">${esc(e.title)}</div><div class="muted" style="font-size:13px">${esc(e.venue || e.city)}${e.priceText ? ' · ' + esc(e.priceText) : ''}</div>
        ${e.friendsGoing?.length ? `<div style="font-size:13px;margin-top:8px">${esc(e.friendsGoing.map(x => '@' + x).join(', '))} going</div>` : ''}
        <a class="btn sm solid block" href="#/e/${esc(e.id)}">View event</a></div>`;
    } else {
      const p = it.p;
      html = `<div class="pop"><div class="kicker">${p.type === 'friend' ? 'Live · ' + ago(p.updatedAt) : p.type === 'meetup' ? 'Meet-up' : 'Event pin'} · @${esc(p.by)}${p.promoted ? ' · Promoted' : ''}</div>
        <div class="h-4">${esc(p.type === 'friend' ? '@' + p.by : p.title)}</div>${p.subtitle ? `<div class="muted" style="font-size:13px">${esc(p.subtitle)}</div>` : ''}${p.description ? `<p style="font-size:14px;margin-top:8px">${esc(p.description)}</p>` : ''}
        ${p.eventId ? `<a class="btn sm solid block" href="#/e/${esc(p.eventId)}">View event</a>` : ''}
        ${p.mine ? `<div style="display:flex;gap:6px;margin-top:10px">${p.type !== 'friend' ? '<button class="btn sm ghost" data-a="promote">Promote</button>' : ''}<button class="btn sm ghost" data-a="delete">${p.type === 'friend' ? 'Stop sharing' : 'Delete'}</button></div>`
          : `<div style="display:flex;gap:6px;margin-top:10px"><button class="btn sm ghost" data-a="msg">Message</button><button class="btn sm ghost" data-a="report">Report</button></div>`}</div>`;
    }
    const pop = L.popup({ closeButton: true, offset: [0, -12], maxWidth: 300 }).setLatLng([it.lat, it.lng]).setContent(html).openOn(map);
    const root = pop.getElement();
    root?.querySelectorAll('[data-a]').forEach(b => (b.onclick = async () => {
      const p = it.p;
      if (b.dataset.a === 'promote') promoteModal('pin', p.id, reload);
      if (b.dataset.a === 'delete') { try { await api(p.type === 'friend' ? '/api/pins/live' : '/api/pins/' + p.id, { method: 'DELETE' }); if (p.type === 'friend') stopLive(); map.closePopup(); reload(); } catch (e) { fail(e); } }
      if (b.dataset.a === 'msg') { if (!state.user) return needLogin('chat'); try { const r = await api('/api/chats', { method: 'POST', body: { members: [p.by] } }); go('/messages/' + r.chatId); } catch (e) { fail(e); } }
      if (b.dataset.a === 'report') state.user ? reportModal('pin', p.id) : needLogin('report');
    }));
  }

  async function reload() {
    const c = map.getCenter(), b = map.getBounds();
    const radius = Math.max(3, Math.min(200, map.distance(c, b.getNorthEast()) / 1000));
    const rg = rangeFor(range, city.tz);
    try {
      const [ev, pn] = await Promise.all([
        api('/api/events?' + qs({ lat: c.lat, lng: c.lng, radius, from: rg.from, to: rg.to, limit: 100, featured: '0' })),
        api('/api/pins?' + qs({ lat: c.lat, lng: c.lng, radius })),
      ]);
      events = ev.events.filter(e => b.contains([e.lat, e.lng])); pins = pn.pins.filter(p => b.contains([p.lat, p.lng]));
      draw();
    } catch (e) { fail(e); }
  }

  function startDrop(type) {
    if (!state.user) return needLogin('pin');
    dropMode = type;
    $('#hint', el).hidden = false;
    $('#hintT', el).textContent = type === 'meetup' ? 'Tap the map where you’ll meet' : 'Tap the map to place your event';
    $('#map', el).style.cursor = 'crosshair';
  }
  const endDrop = () => { dropMode = null; $('#hint', el).hidden = true; $('#map', el).style.cursor = ''; };
  $('#hintX', el).onclick = endDrop;
  $('#addEv', el).onclick = () => startDrop('event');
  $('#addMeet', el).onclick = () => startDrop('meetup');
  map.on('click', ev => { if (dropMode) { const t = dropMode; endDrop(); pinForm(t, ev.latlng); } });

  function pinForm(type, ll) {
    const m = modal(`${modalHead(type === 'meetup' ? 'New meet-up' : 'New event pin', 'Map')}
      <form class="modal-b" id="pf">
        <label class="field"><span>Title</span><input class="input" name="title" required maxlength="100" placeholder="${type === 'meetup' ? 'Pre-drinks before Drugstore' : 'Rooftop session'}"></label>
        <label class="field"><span>When / details line</span><input class="input" name="subtitle" maxlength="140" placeholder="Sat 22:00 · bring ID"></label>
        <label class="field"><span>More info</span><textarea class="textarea" name="description" maxlength="500" style="min-height:80px"></textarea></label>
        ${type === 'event' ? '<label class="field"><span>Price (NKT, optional)</span><input class="input" name="price" inputmode="decimal"></label>' : ''}
        <label class="field"><span>Who can see it</span><select class="select" name="visibility"><option value="all_friends">Friends</option><option value="close_friends">Close friends</option><option value="public">Everyone</option></select></label>
        ${type === 'event' ? '<p class="muted" style="font-size:12px">Selling tickets? <a class="link" href="#/create">Post a full event</a> instead.</p>' : ''}
      </form>
      <div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="drop">Drop pin</button></div>`);
    $('#drop', m.el).onclick = ev => {
      const f = $('#pf', m.el);
      if (!f.reportValidity()) return;
      busy(ev.currentTarget, async () => {
        try { const r = await api('/api/pins', { method: 'POST', body: { type, lat: ll.lat, lng: ll.lng, ...formData(f) } }); m.close(); selected = r.pin.id; toast('Pin dropped.'); reload(); }
        catch (e) { fail(e); }
      });
    };
  }

  // Live location: shared with friends while this tab is open, every ~30 s.
  function stopLive() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    const b = $('#live', el);
    if (b) { b.classList.remove('on'); b.innerHTML = icon('locate') + 'Share location'; }
  }
  $('#live', el).onclick = async () => {
    if (!state.user) return needLogin('live');
    if (watchId != null) { await api('/api/pins/live', { method: 'DELETE' }).catch(() => {}); stopLive(); toast('Stopped sharing.'); reload(); return; }
    if (!navigator.geolocation) return toast('Location isn’t available on this device.', 'err');
    let first = true;
    watchId = navigator.geolocation.watchPosition(async pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      if (first) { map.flyTo([lat, lng], 16); first = false; }
      if (Date.now() - lastSent < 30000) return;
      lastSent = Date.now();
      try { await api('/api/pins/live', { method: 'POST', body: { lat, lng, visibility: 'all_friends' } }); reload(); } catch (e) { fail(e); }
    }, () => { toast('Allow location access to share where you are.', 'err'); stopLive(); }, { enableHighAccuracy: true, maximumAge: 15000 });
    const b = $('#live', el);
    b.classList.add('on'); b.innerHTML = icon('locate') + 'Sharing';
    toast('Friends can see where you are while this is on.');
  };

  $$('[data-r]', el).forEach(b => (b.onclick = () => { range = b.dataset.r; $$('[data-r]', el).forEach(x => x.classList.toggle('on', x === b)); reload(); }));
  $$('[data-f]', el).forEach(b => (b.onclick = () => { filter = b.dataset.f; $$('[data-f]', el).forEach(x => x.classList.toggle('on', x === b)); draw(); }));
  let mt;
  map.on('moveend', () => { clearTimeout(mt); mt = setTimeout(reload, 400); });
  map.on('zoomend', draw);
  setTimeout(() => map.invalidateSize(), 50);
  await reload();
  const offs = [on('rt:pins_changed', reload), on('rt:events_changed', reload)];
  return () => { offs.forEach(f => f()); map.remove(); };
}

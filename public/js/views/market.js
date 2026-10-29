import { state, api, qs, esc, icon, ago, nkt, safeUrl, avatar, go, fail, toast, modal, modalHead, busy, upload, pickFile, confirmBox, newKey, formData, $, $$ } from '../core.js';
import { promoteModal, reportModal, needLogin } from './shared.js';

const CATS = [['all', 'All'], ['tickets', 'Tickets'], ['clothing', 'Clothing'], ['gear', 'Gear'], ['records', 'Records'], ['art', 'Art'], ['services', 'Services'], ['other', 'Other']];

export async function marketView(el) {
  let cat = 'all', term = '', mine = false, items = [];
  el.innerHTML = `<div class="wrap">
    <div class="page-h"><div class="kicker">${esc(state.city.name)} · market</div><div class="page-h-row"><h1 class="h-1">Market</h1><button class="btn solid" id="sell">${icon('plus')}Sell something</button></div>
      <p class="lead" style="margin-top:16px;max-width:600px">Spare tickets, records, clothes and gear from people around you. Paid in NKT, straight to the seller.</p></div>
    <div class="rail" style="position:static;border-bottom:0"><div class="rail-in">${CATS.map(([k, l]) => `<button data-c="${k}" class="${k === cat ? 'on' : ''}">${l}</button>`).join('')}
      <div class="rail-tools"><div class="search">${icon('search')}<input id="mq" placeholder="Search the market"></div>${state.user ? '<button class="chip" id="mine" style="margin-left:12px">My listings</button>' : ''}</div></div></div>
    <div id="grid" style="border-top:1px solid var(--line)"><div class="empty">Loading…</div></div></div>`;

  async function load() {
    try { items = (await api('/api/market?' + qs({ category: cat === 'all' ? '' : cat, q: term, city: mine ? '' : state.city.name, mine: mine ? '1' : '' }))).items; draw(); }
    catch (e) { fail(e); }
  }
  function draw() {
    $('#grid', el).innerHTML = items.length ? `<div class="mgrid">${items.map(i => `<div class="mcard" data-id="${esc(i.id)}">
        <div class="img">${i.image ? `<img src="${safeUrl(i.image)}" alt="" loading="lazy">` : `<div class="ph">${icon('bag')}</div>`}<div class="ecard-tag">${i.promoted ? '<span class="tag">Promoted</span>' : ''}${i.status === 'sold' ? '<span class="tag">Sold</span>' : ''}</div></div>
        <div class="kicker">${esc(i.category)}${i.condition ? ' · ' + esc(i.condition) : ''} · ${ago(i.createdAt)}</div>
        <div class="h-4">${esc(i.title)}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:auto"><span class="p">${nkt(i.price)} NKT</span><span class="muted" style="font-size:12px">@${esc(i.seller.handle)}</span></div></div>`).join('')}</div>`
      : `<div class="empty"><div class="h-3">${mine ? 'You have no listings' : 'Nothing listed here yet'}</div><p>List a spare ticket or something you don’t wear anymore.</p><button class="btn" id="sell2">Sell something</button></div>`;
    $$('[data-id]', el).forEach(c => (c.onclick = () => openItem(items.find(i => i.id === c.dataset.id))));
    const s2 = $('#sell2', el); if (s2) s2.onclick = sell;
  }
  function openItem(i) {
    const key = newKey();
    const m = modal(`${modalHead(i.title, i.category + (i.city ? ' · ' + i.city : ''))}
      <div class="modal-b">${i.image ? `<div class="ev-flyer" style="aspect-ratio:1;min-height:0;margin-bottom:20px;border:1px solid var(--line)"><img src="${safeUrl(i.image)}" alt=""></div>` : ''}
        <div class="bal" style="font-size:56px">${nkt(i.price)}<small>NKT</small></div>
        ${i.description ? `<p class="prose" style="font-size:16px;margin-top:16px">${esc(i.description)}</p>` : ''}
        <div class="list-row" style="margin-top:16px"><a href="#/u/${esc(i.seller.handle)}">${avatar(i.seller)}</a><div class="t"><b>@${esc(i.seller.handle)}</b><span>${i.condition ? esc(i.condition) + ' · ' : ''}listed ${ago(i.createdAt)}</span></div></div>
        <p class="muted" style="font-size:12px;margin-top:14px">Meet in a public place for hand-overs. For tickets, ask the seller to send the ticket to you in the app — it re-issues the code so it can’t be resold twice.</p></div>
      <div class="modal-f">${i.mine ? `<button class="btn ghost" id="del">${icon('trash')}Remove</button><button class="btn solid" id="promo">${icon('promote')}Promote</button>`
        : i.status === 'active' ? `<button class="btn ghost" id="msg">${icon('chat')}Message</button><button class="btn solid" id="buy">Buy · ${nkt(i.price)}</button>` : '<span class="muted">Sold</span>'}</div>`);
    const b = id => m.el.querySelector(id);
    if (b('#buy')) b('#buy').onclick = ev => {
      if (!state.user) return needLogin('buy');
      busy(ev.currentTarget, async () => {
        if (!(await confirmBox(`Buy for ${nkt(i.price)} NKT?`, 'The seller is paid immediately. Message them to arrange the hand-over.', 'Buy'))) return;
        try {
          const r = await api(`/api/market/${i.id}/buy`, { method: 'POST', idem: key });
          state.user.balance = r.balance; m.close(); toast('Bought. Message the seller to arrange hand-over.');
          const c = await api('/api/chats', { method: 'POST', body: { members: [r.seller] } }); go('/messages/' + c.chatId);
        } catch (e) { if (e.code === 'insufficient_funds') toast(e.message, 'err', { label: 'Top up', fn: () => { m.close(); go('/wallet?topup=1'); } }); else fail(e); }
      });
    };
    if (b('#msg')) b('#msg').onclick = async () => { if (!state.user) return needLogin('chat'); try { const c = await api('/api/chats', { method: 'POST', body: { members: [i.seller.handle] } }); m.close(); go('/messages/' + c.chatId); } catch (e) { fail(e); } };
    if (b('#del')) b('#del').onclick = async () => { try { await api('/api/market/' + i.id, { method: 'DELETE' }); m.close(); toast('Listing removed.'); load(); } catch (e) { fail(e); } };
    if (b('#promo')) b('#promo').onclick = () => { m.close(); promoteModal('listing', i.id, load); };
    if (!i.mine && state.user) {
      const rep = document.createElement('button');
      rep.className = 'link'; rep.style.cssText = 'margin:0 24px 24px'; rep.textContent = 'Report listing';
      rep.onclick = () => { m.close(); reportModal('listing', i.id); };
      m.el.appendChild(rep);
    }
  }
  function sell() {
    if (!state.user) return needLogin('sell');
    let imageUpload = null;
    const m = modal(`${modalHead('Sell something', 'Market')}
      <form class="modal-b" id="sf">
        <button type="button" class="ev-flyer" id="ph" style="width:100%;aspect-ratio:16/10;min-height:0;border:1px dashed var(--line-3);margin-bottom:18px;display:block"><div class="ph" style="font:500 12px var(--f-display);letter-spacing:.2em;text-transform:uppercase">${icon('image', 'style="width:28px;height:28px"')}<br>Add photo</div></button>
        <label class="field"><span>Title</span><input class="input" name="title" required maxlength="100"></label>
        <div class="row"><label class="field"><span>Price (NKT)</span><input class="input" name="price" required inputmode="decimal"></label>
          <label class="field"><span>Category</span><select class="select" name="category">${CATS.slice(1).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label></div>
        <label class="field"><span>Condition</span><select class="select" name="condition"><option value="">—</option><option>new</option><option>like new</option><option>good</option><option>used</option></select></label>
        <label class="field"><span>Description</span><textarea class="textarea" name="description" maxlength="1500"></textarea></label>
        <p class="muted" style="font-size:12px">No weapons, drugs, counterfeit goods or anything illegal. See <a href="/guidelines" target="_blank" style="text-decoration:underline">guidelines</a>.</p>
      </form><div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="go">List it</button></div>`);
    $('#ph', m.el).onclick = async () => { const f = await pickFile(); if (!f) return; try { const r = await upload(f, 'listing'); imageUpload = r.id; $('#ph', m.el).innerHTML = `<img src="${safeUrl(r.url)}" alt="" style="width:100%;height:100%;object-fit:cover">`; } catch (e) { fail(e); } };
    $('#go', m.el).onclick = ev => {
      const f = $('#sf', m.el);
      if (!f.reportValidity()) return;
      busy(ev.currentTarget, async () => { try { await api('/api/market', { method: 'POST', body: { ...formData(f), imageUpload, city: state.city.name } }); m.close(); toast('Listed.'); load(); } catch (e) { fail(e); } });
    };
  }
  $$('[data-c]', el).forEach(b => (b.onclick = () => { cat = b.dataset.c; $$('[data-c]', el).forEach(x => x.classList.toggle('on', x === b)); load(); }));
  let t;
  $('#mq', el).oninput = e => { clearTimeout(t); t = setTimeout(() => { term = e.target.value.trim(); load(); }, 300); };
  $('#sell', el).onclick = sell;
  const mb = $('#mine', el); if (mb) mb.onclick = () => { mine = !mine; mb.classList.toggle('on', mine); load(); };
  await load();
}

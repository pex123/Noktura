// Dialogs used across views: promote, report, send money, request, split.
import { state, api, esc, icon, modal, modalHead, toast, fail, busy, nkt, newKey, go, formData, $ } from '../core.js';

const DAYS = [1, 3, 7, 14, 30];
const NOUN = { post: 'post', pin: 'map pin', event: 'event', listing: 'listing' };

export async function promoteModal(targetType, targetId, onDone) {
  let prices = { post: 2, pin: 2, listing: 1.5, event: 5 };
  try { prices = (await api('/api/promote/prices')).prices; } catch { /* defaults */ }
  const per = prices[targetType];
  let days = 3;
  const m = modal(`${modalHead('Promote this ' + NOUN[targetType], 'Reach more people')}
    <div class="modal-b">
      <p class="muted" style="margin-bottom:20px">Promoted ${NOUN[targetType]}s are shown first ${targetType === 'post' ? 'in the city feed' : targetType === 'pin' ? 'on the map' : targetType === 'event' ? 'in Selected and at the top of the city page' : 'in the market'}, marked “Promoted”. Paid from your NKT balance.</p>
      <div class="seg" id="days">${DAYS.map(d => `<button data-d="${d}" class="${d === days ? 'on' : ''}">${d}d</button>`).join('')}</div>
      <div class="total" style="margin-top:20px"><span>${nkt(per)} NKT per day</span><b id="cost">${nkt(per * days)} NKT</b></div>
      <p class="muted" style="font-size:12px">Balance: ${nkt(state.user?.balance)} NKT</p>
    </div>
    <div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="go">Promote</button></div>`);
  const key = newKey();
  m.el.querySelectorAll('[data-d]').forEach(b => (b.onclick = () => {
    days = +b.dataset.d;
    m.el.querySelectorAll('[data-d]').forEach(x => x.classList.toggle('on', x === b));
    m.el.querySelector('#cost').textContent = nkt(per * days) + ' NKT';
  }));
  m.el.querySelector('#go').onclick = e => busy(e.currentTarget, async () => {
    try {
      const r = await api('/api/promote', { method: 'POST', body: { targetType, targetId, days }, idem: key });
      if (state.user) state.user.balance = r.balance;
      toast(`Promoted until ${new Date(r.promotedUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`);
      m.close(); onDone && onDone();
    } catch (err) {
      if (err.code === 'insufficient_funds') { m.close(); toast(err.message, 'err', { label: 'Top up', fn: () => go('/wallet?topup=1') }); }
      else fail(err);
    }
  });
}

const REASONS = ['Spam or scam', 'Harassment or hate', 'Violence or threats', 'Nudity or sexual content', 'Illegal goods or activity', 'Fake event or tickets', 'Something else'];
export function reportModal(targetType, targetId) {
  const m = modal(`${modalHead('Report', 'Help keep NOKTURA safe')}
    <form class="modal-b" id="rf">
      <label class="field"><span>Reason</span><select class="select" name="reason">${REASONS.map(r => `<option>${r}</option>`).join('')}</select></label>
      <label class="field"><span>Details (optional)</span><textarea class="textarea" name="details" maxlength="1000"></textarea></label>
      <p class="muted" style="font-size:13px">Reports are anonymous to the person reported. If someone is in danger, contact local emergency services.</p>
    </form>
    <div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="send">Send report</button></div>`);
  m.el.querySelector('#send').onclick = e => busy(e.currentTarget, async () => {
    try { await api('/api/reports', { method: 'POST', body: { targetType, targetId, ...formData(m.el.querySelector('#rf')) } }); toast('Thanks — our team will review it.'); m.close(); }
    catch (err) { fail(err); }
  });
}

// Send NKT. `preset` can carry toHandle, amount, note (from a QR code or "buy a round").
export async function sendModal(preset = {}, onDone) {
  let wallet = null;
  try { wallet = await api('/api/wallet'); } catch { /* shown as unknown balance */ }
  const confirmAbove = wallet?.limits?.confirmAbove ?? 300;
  const key = newKey();
  const m = modal(`${modalHead(preset.title || 'Send NKT', 'Wallet')}
    <form class="modal-b" id="sf" autocomplete="off">
      <label class="field"><span>To</span><input class="input" name="toHandle" placeholder="@handle" value="${esc(preset.toHandle ? '@' + preset.toHandle.replace(/^@/, '') : '')}" required></label>
      <div class="amount-input"><input name="amount" inputmode="decimal" placeholder="0.00" value="${esc(preset.amount || '')}" aria-label="Amount"><span>NKT</span></div>
      <div class="chips" style="margin:-8px 0 20px">${[5, 10, 20, 50].map(v => `<button type="button" class="chip" data-amt="${v}">${v}</button>`).join('')}</div>
      <label class="field"><span>Note</span><input class="input" name="note" maxlength="140" placeholder="Drinks, ticket, taxi…" value="${esc(preset.note || '')}"></label>
      <label class="field" id="pw" hidden><span>Password — required above ${nkt(confirmAbove)} NKT</span><input class="input" type="password" name="password" autocomplete="current-password"></label>
      <p class="muted" style="font-size:12px">Balance ${wallet ? nkt(wallet.balance) : '—'} NKT · Payments to other people are instant and can’t be reversed by NOKTURA.</p>
    </form>
    <div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="go">${icon('send')}Send</button></div>`);
  const f = m.el.querySelector('#sf');
  const amt = f.querySelector('[name=amount]');
  const check = () => { m.el.querySelector('#pw').hidden = !(Number(amt.value) >= confirmAbove); };
  amt.oninput = check; check();
  f.querySelectorAll('[data-amt]').forEach(b => (b.onclick = () => { amt.value = b.dataset.amt; check(); }));
  if (preset.toHandle && !preset.amount) setTimeout(() => amt.focus(), 60);
  m.el.querySelector('#go').onclick = e => busy(e.currentTarget, async () => {
    const d = formData(f);
    try {
      const r = await api('/api/wallet/transfer', { method: 'POST', body: { toHandle: d.toHandle, amount: d.amount, note: d.note, password: d.password || undefined }, idem: key });
      if (state.user) state.user.balance = r.balance;
      toast(`Sent ${nkt(d.amount)} NKT to ${d.toHandle.startsWith('@') ? d.toHandle : '@' + d.toHandle}.`);
      m.close(); onDone && onDone();
    } catch (err) {
      if (err.code === 'insufficient_funds') toast(err.message, 'err', { label: 'Top up', fn: () => { m.close(); go('/wallet?topup=1'); } });
      else fail(err);
    }
  });
}

export function requestModal({ split = false, toHandles = [], total = '', note = '' } = {}, onDone) {
  const m = modal(`${modalHead(split ? 'Split a bill' : 'Request NKT', 'Wallet')}
    <form class="modal-b" id="rq" autocomplete="off">
      <label class="field"><span>${split ? 'Split with' : 'From'}</span><input class="input" name="to" placeholder="@mila, @luka" value="${esc(toHandles.map(x => '@' + x).join(', '))}" required></label>
      <div class="amount-input"><input name="amount" inputmode="decimal" placeholder="0.00" value="${esc(total)}" aria-label="${split ? 'Total' : 'Amount'}"><span>${split ? 'NKT TOTAL' : 'NKT'}</span></div>
      ${split ? '<label class="check"><input type="checkbox" name="includeMe" checked> Include me in the split</label><p class="muted" id="each" style="font-size:13px;margin-bottom:16px"></p>' : ''}
      <label class="field"><span>For</span><input class="input" name="note" maxlength="140" placeholder="Table at Drugstore, taxi home…" value="${esc(note)}"></label>
    </form>
    <div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="go">Send request</button></div>`);
  const f = m.el.querySelector('#rq');
  const people = () => f.to.value.split(/[\s,]+/).map(s => s.replace(/^@/, '')).filter(Boolean);
  const upd = () => {
    if (!split) return;
    const n = people().length + (f.includeMe.checked ? 1 : 0);
    const each = n ? Math.floor((Number(f.amount.value) || 0) / n * 100) / 100 : 0;
    m.el.querySelector('#each').textContent = n && each ? `${n} ways · ${nkt(each)} NKT each` : '';
  };
  f.oninput = upd; upd();
  m.el.querySelector('#go').onclick = e => busy(e.currentTarget, async () => {
    const d = formData(f);
    try {
      const body = split ? { toHandles: people(), split: true, total: d.amount, includeMe: f.includeMe.checked, note: d.note } : { toHandles: people(), amount: d.amount, note: d.note };
      const r = await api('/api/wallet/requests', { method: 'POST', body });
      toast(`Request sent to ${r.count} ${r.count === 1 ? 'person' : 'people'} · ${nkt(r.each)} NKT each.`);
      m.close(); onDone && onDone();
    } catch (err) { fail(err); }
  });
}

export function moreMenu(anchor, items) {
  document.querySelectorAll('.menu-pop').forEach(x => x.remove());
  const r = anchor.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'menu-pop';
  pop.style.cssText = `position:fixed;z-index:120;top:${Math.min(r.bottom + 4, innerHeight - 40 * items.length - 10)}px;left:${Math.max(8, Math.min(r.right - 220, innerWidth - 228))}px;width:220px;background:var(--bg);border:1px solid var(--fg)`;
  pop.innerHTML = items.map((it, i) => `<button data-i="${i}" style="display:flex;width:100%;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line);font-size:14px;text-align:left">${icon(it.icon, 'style="width:16px;height:16px"')}${esc(it.label)}</button>`).join('');
  document.body.appendChild(pop);
  pop.querySelectorAll('button').forEach(b => (b.onclick = () => { pop.remove(); items[+b.dataset.i].fn(); }));
  setTimeout(() => document.addEventListener('mousedown', function off(ev) { if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('mousedown', off); } }), 0);
}

export const needLogin = why => { go('/join?why=' + encodeURIComponent(why) + '&next=' + encodeURIComponent(location.hash.slice(1))); };
export { $ };

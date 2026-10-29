import { state, api, esc, icon, ago, fDay, fTime, nkt, plural, go, fail, toast, modal, modalHead, busy, qrSvg, newKey, confirmBox, currentQuery, on, CFG, $, $$ } from '../core.js';
import { sendModal, requestModal, needLogin } from './shared.js';
import { startScanner } from './door.js';
import { eventImg } from './events.js';

const TX_LABEL = {
  transfer: 'Payment', request_paid: 'Request paid', paypal_topup: 'Top-up', paypal_payout: 'Withdrawal', paypal_payout_pending: 'Withdrawal (processing)',
  ticket_purchase: 'Tickets', ticket_sale: 'Ticket sale', ticket_refund: 'Refund', event_refund: 'Event refunds', market_purchase: 'Market', market_fee: 'Market fee',
  promotion: 'Promotion', ad_budget_hold: 'Sponsored card', ad_budget_refund: 'Card refund', ad_reward: 'Reward', step_milestone: 'Steps reward',
};

const isHandle = s => /^[A-Za-z0-9_]{3,20}$/.test(s || '') && !['NOKTURA', 'PayPal'].includes(s);
function txTitle(t) {
  const who = t.direction === 'in' ? t.from : t.to;
  if (['transfer', 'request_paid', 'market_purchase', 'ticket_sale'].includes(t.type) && isHandle(who)) return '@' + who;
  return TX_LABEL[t.type] || t.type;
}

export async function walletView(el) {
  if (!state.user) return needLogin('wallet');
  const q = currentQuery();
  let w;
  const load = async () => { w = await api('/api/wallet'); state.user.balance = w.balance; };
  try { await load(); } catch (e) { el.innerHTML = `<div class="wrap empty">${esc(e.message)}</div>`; return; }

  function draw() {
    const incoming = w.requests.filter(r => r.incoming && r.status === 'open');
    const outgoing = w.requests.filter(r => !r.incoming && r.status === 'open');
    el.innerHTML = `<div class="wrap">
      <div class="wal-hero">
        <div><div class="kicker" style="margin-bottom:22px">Wallet · @${esc(state.user.handle)}</div><div class="bal">${nkt(w.balance)}<small>NKT</small></div>
          <p class="muted" style="margin-top:18px;font-size:13px">1 NKT = 1 USD · Send to anyone on NOKTURA instantly · Withdraw to PayPal</p></div>
        <div class="actions">
          <button data-a="send">${icon('send')}<span class="label">Send</span></button>
          <button data-a="request">${icon('request')}<span class="label">Request</span></button>
          <button data-a="split">${icon('split')}<span class="label">Split</span></button>
          <button data-a="scan">${icon('scan')}<span class="label">Pay QR</span></button>
          <button data-a="receive">${icon('qr')}<span class="label">Receive</span></button>
          <button data-a="topup">${icon('topup')}<span class="label">Top up</span></button>
          <button data-a="withdraw">${icon('withdraw')}<span class="label">Withdraw</span></button>
          <a href="#/tickets">${icon('ticket')}<span class="label">Tickets</span></a>
        </div>
      </div>
      <div class="split" style="padding:40px 0 80px">
        <div>
          ${incoming.length ? `<div class="label muted" style="margin-bottom:14px">Requests for you</div>${incoming.map(r => `<div class="req"><div><b>@${esc(r.from)}</b><div class="muted" style="font-size:13px">${esc(r.note || 'Request')} · ${ago(r.at)}</div></div><div style="text-align:right"><div class="amt num">${nkt(r.amount)}</div>
            <div style="display:flex;gap:6px;margin-top:8px"><button class="btn sm ghost" data-dec="${esc(r.id)}">Decline</button><button class="btn sm solid" data-payreq="${esc(r.id)}" data-amt="${r.amount}">Pay</button></div></div></div>`).join('')}<div style="height:32px"></div>` : ''}
          <div class="sec-h" style="padding-bottom:14px"><div class="label muted">Activity</div><a class="link" href="#/earn">Earn NKT${icon('arrow')}</a></div>
          <div class="txl" style="border-top:0">${w.transactions.length ? w.transactions.map(t => `<div class="tx"><span class="ic">${icon(t.direction === 'in' ? 'arrowDownLeft' : 'arrowUpRight')}</span>
            <div><b>${esc(txTitle(t))}</b><span>${esc(t.note || TX_LABEL[t.type] || '')} · ${ago(t.at)}</span></div>
            <span class="amt">${t.direction === 'in' ? '+' : '−'}${nkt(t.amount)}</span></div>`).join('') : '<div class="empty">No activity yet. Top up, or ask a friend to send you NKT.</div>'}</div>
        </div>
        <aside>
          <div class="label muted" style="margin-bottom:14px">Buy a round</div>
          <p class="muted" style="font-size:14px;margin-bottom:14px">Cover a friend’s drink, the taxi or the table — it lands in their wallet instantly.</p>
          <div class="rounds">${[['Drink', 5], ['Round', 20], ['Taxi', 10], ['Entry', 15], ['Table', 50]].map(([l, v]) => `<button class="chip" data-round="${v}" data-note="${l}">${l} · ${v}</button>`).join('')}</div>
          ${outgoing.length ? `<div class="label muted" style="margin:36px 0 14px">Waiting on</div>${outgoing.map(r => `<div class="list-row"><div class="t"><b>@${esc(r.to)}</b><span>${esc(r.note || 'Request')} · ${ago(r.at)}</span></div><span class="num">${nkt(r.amount)}</span><button class="btn sm ghost" data-cancel="${esc(r.id)}">Cancel</button></div>`).join('')}` : ''}
          <div class="label muted" style="margin:36px 0 14px">Limits</div>
          <div class="facts"><div class="fact"><dt>Per payment</dt><dd class="num">${nkt(w.limits.maxTransfer)} NKT</dd></div><div class="fact"><dt>Per day</dt><dd class="num">${nkt(w.limits.dailyOut)} NKT</dd></div><div class="fact"><dt>Password</dt><dd>Asked above ${nkt(w.limits.confirmAbove)} NKT</dd></div></div>
          <p class="muted" style="font-size:12px;margin-top:16px">NKT is prepaid credit for use on NOKTURA, not a bank account or investment. See <a href="/terms#wallet" style="text-decoration:underline">wallet terms</a>.</p>
        </aside>
      </div></div>`;

    const act = {
      send: () => sendModal({}, refresh),
      request: () => requestModal({}, refresh),
      split: () => requestModal({ split: true }, refresh),
      scan: scanToPay,
      receive: receive,
      topup: topup,
      withdraw: withdraw,
    };
    $$('[data-a]', el).forEach(b => (b.onclick = () => act[b.dataset.a]()));
    $$('[data-round]', el).forEach(b => (b.onclick = () => sendModal({ amount: b.dataset.round, note: b.dataset.note === 'Round' ? 'This round’s on me' : b.dataset.note, title: b.dataset.note === 'Round' ? 'Buy a round' : 'Send NKT' }, refresh)));
    $$('[data-payreq]', el).forEach(b => (b.onclick = () => payRequest(b.dataset.payreq, +b.dataset.amt)));
    $$('[data-dec]', el).forEach(b => (b.onclick = async () => { try { await api(`/api/wallet/requests/${b.dataset.dec}/decline`, { method: 'POST' }); refresh(); } catch (e) { fail(e); } }));
    $$('[data-cancel]', el).forEach(b => (b.onclick = async () => { try { await api(`/api/wallet/requests/${b.dataset.cancel}/cancel`, { method: 'POST' }); refresh(); } catch (e) { fail(e); } }));
  }
  const refresh = async () => { try { await load(); draw(); } catch (e) { fail(e); } };

  async function payRequest(id, amount) {
    let password;
    if (amount >= w.limits.confirmAbove) {
      password = await new Promise(res => {
        const m = modal(`${modalHead('Confirm payment')}<form class="modal-b" id="pw"><label class="field"><span>Password</span><input class="input" type="password" name="p" autocomplete="current-password" required></label></form><div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="ok">Pay ${nkt(amount)} NKT</button></div>`, { onClose: () => res(null) });
        $('#ok', m.el).onclick = () => { const v = $('#pw', m.el).p.value; m.close(); res(v); };
      });
      if (!password) return;
    } else if (!(await confirmBox(`Pay ${nkt(amount)} NKT?`, 'The money goes to them straight away.', 'Pay'))) return;
    try { await api(`/api/wallet/requests/${id}/pay`, { method: 'POST', body: { password }, idem: true }); toast('Paid.'); refresh(); }
    catch (e) { if (e.code === 'insufficient_funds') toast(e.message, 'err', { label: 'Top up', fn: topup }); else fail(e); }
  }

  function receive() {
    const payload = `noktura:pay?to=${encodeURIComponent(state.user.handle)}`;
    const m = modal(`${modalHead('Receive NKT', '@' + state.user.handle)}
      <div class="modal-b" style="text-align:center"><div class="qr" id="rq">${qrSvg(payload)}</div>
        <div class="amount-input" style="margin-top:20px;justify-content:center"><input id="ra" inputmode="decimal" placeholder="Any amount" style="text-align:center;font-size:40px"><span>NKT</span></div>
        <input class="input" id="rn" placeholder="What’s it for? (optional)" maxlength="60">
        <p class="muted" style="font-size:13px;margin-top:14px">Show this at the bar or to a friend. They scan it with Pay QR in their NOKTURA wallet.</p></div>`);
    const upd = () => {
      const a = $('#ra', m.el).value, n = $('#rn', m.el).value;
      $('#rq', m.el).innerHTML = qrSvg(payload + (Number(a) > 0 ? '&amount=' + encodeURIComponent(a) : '') + (n ? '&note=' + encodeURIComponent(n) : ''));
    };
    $('#ra', m.el).oninput = upd; $('#rn', m.el).oninput = upd;
  }

  function scanToPay() {
    const m = modal(`${modalHead('Scan to pay', 'Pay QR')}<div class="modal-b"><div class="scan"><video playsinline muted></video><div class="frame"></div></div><p class="muted" style="text-align:center;margin-top:14px;font-size:13px">Point the camera at a NOKTURA payment code.</p></div>`, { onClose: () => stop?.() });
    const stop = startScanner($('video', m.el), text => {
      const match = /^noktura:pay\?(.+)$/.exec(text);
      if (!match) { toast('That isn’t a NOKTURA payment code.', 'err'); return false; }
      const p = new URLSearchParams(match[1]);
      m.close();
      sendModal({ toHandle: p.get('to'), amount: p.get('amount') || '', note: p.get('note') || '', title: 'Pay @' + p.get('to') }, refresh);
      return true;
    });
  }

  function topup() {
    if (!CFG.paypal) return toast('Card and PayPal top-ups aren’t switched on yet. Ask a friend to send you NKT.', 'err');
    const m = modal(`${modalHead('Top up', 'PayPal or card')}
      <form class="modal-b" id="tf"><div class="amount-input"><input name="amount" inputmode="decimal" placeholder="0.00" value="20"><span>USD → NKT</span></div>
        <div class="chips" style="margin:-8px 0 20px">${[10, 20, 50, 100].map(v => `<button type="button" class="chip" data-v="${v}">${v}</button>`).join('')}</div>
        <p class="muted" style="font-size:13px">You’ll approve the payment in a PayPal window — card works too, no PayPal account needed. NKT is added the moment it completes.</p></form>
      <div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="go">Continue to PayPal</button></div>`);
    const f = $('#tf', m.el);
    $$('[data-v]', f).forEach(b => (b.onclick = () => { f.amount.value = b.dataset.v; }));
    $('#go', m.el).onclick = ev => busy(ev.currentTarget, async () => {
      const popup = window.open('about:blank', 'paypal', 'width=480,height=720');
      try {
        const r = await api('/api/wallet/paypal/create-order', { method: 'POST', body: { amount: f.amount.value } });
        if (popup) popup.location = r.approveUrl; else location.href = r.approveUrl;
        const finish = async () => {
          try { const c = await api(`/api/wallet/paypal/capture/${r.orderId}`, { method: 'POST' }); off(); m.close(); toast(`${nkt(c.credited)} NKT added.`); refresh(); }
          catch (err) { fail(err); }
        };
        const off = on('paypal', d => { if (d.status === 'approved') finish(); else { off(); m.close(); toast('Top-up cancelled. Nothing was charged.'); } });
        $('.modal-b', m.el).innerHTML = '<p class="lead">Approve the payment in the PayPal window. This finishes automatically.</p>';
        $('.modal-f', m.el).innerHTML = '<button class="btn solid block" id="fin">I’ve approved it</button>';
        $('#fin', m.el).onclick = e2 => busy(e2.currentTarget, finish);
      } catch (err) { popup?.close(); fail(err); }
    });
  }

  function withdraw() {
    if (!CFG.paypal) return toast('Withdrawals aren’t switched on yet.', 'err');
    const m = modal(`${modalHead('Withdraw to PayPal', 'Wallet')}
      <form class="modal-b" id="wf"><div class="amount-input"><input name="amount" inputmode="decimal" placeholder="0.00"><span>NKT → USD</span></div>
        <label class="field"><span>PayPal email</span><input class="input" type="email" name="paypalEmail" required></label>
        <label class="field"><span>Your password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
        <p class="muted" style="font-size:12px">Available: ${nkt(w.balance)} NKT · Minimum 5 · PayPal may take up to a day to show it.</p></form>
      <div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="go">Withdraw</button></div>`);
    $('#go', m.el).onclick = ev => {
      const f = $('#wf', m.el);
      if (!f.reportValidity()) return;
      busy(ev.currentTarget, async () => {
        try { await api('/api/wallet/paypal/payout', { method: 'POST', body: { amount: f.amount.value, paypalEmail: f.paypalEmail.value, password: f.password.value } }); m.close(); toast('Withdrawal sent to PayPal.'); refresh(); }
        catch (err) { fail(err); }
      });
    };
  }

  draw();
  if (q.topup) topup();
  const off = on('rt:wallet_update', refresh);
  return off;
}

export async function ticketsView(el) {
  if (!state.user) return needLogin('tickets');
  let tickets;
  try { tickets = (await api('/api/tickets/mine')).tickets; } catch (e) { el.innerHTML = `<div class="wrap empty">${esc(e.message)}</div>`; return; }
  const upcoming = tickets.filter(t => !t.refunded && !t.redeemed && (!t.startsAt || t.startsAt > Date.now() - 12 * 3600000));
  const past = tickets.filter(t => !upcoming.includes(t));
  const card = t => `<div class="tixc ${t.redeemed || t.refunded ? 'used' : ''}" data-id="${esc(t.id)}">
    <div class="kicker"><b>${t.startsAt ? esc(fDay(t.startsAt)) + ' · ' + esc(fTime(t.startsAt)) : ''}</b>${t.refunded ? ' · Refunded' : t.redeemed ? ' · Scanned' : ''}</div>
    <div class="h-4">${esc(t.title)}</div><div class="muted" style="font-size:13px">${esc(t.tier)} · ${esc(t.venue || t.city)}</div>
    <div class="code" style="text-align:left;font-size:13px">${esc(t.code)}</div></div>`;
  el.innerHTML = `<div class="wrap"><div class="page-h"><div class="kicker">Wallet</div><div class="page-h-row"><h1 class="h-1">Tickets</h1><a class="btn ghost" href="#/wallet">${icon('back')}Wallet</a></div></div>
    <div class="sec">${upcoming.length ? `<div class="tix">${upcoming.map(card).join('')}</div>` : '<div class="empty"><div class="h-3">No upcoming tickets</div><p>Tickets you buy or receive show up here as QR codes.</p><a class="btn" href="#/">Find events</a></div>'}</div>
    ${past.length ? `<div class="sec" style="padding-top:0"><div class="label muted" style="margin-bottom:14px">Past &amp; used</div><div class="tix">${past.map(card).join('')}</div></div>` : ''}</div>`;
  $$('[data-id]', el).forEach(c => (c.onclick = () => openTicket(tickets.find(t => t.id === c.dataset.id), () => ticketsView(el))));
}

function openTicket(t, refresh) {
  const live = !t.redeemed && !t.refunded;
  const m = modal(`${modalHead(t.title, t.tier)}
    <div class="modal-b" style="text-align:center">
      ${live ? `<div class="qr">${qrSvg(t.code)}</div>` : `<div class="empty">${t.refunded ? 'Refunded' : 'Scanned at the door'}</div>`}
      <div class="code" style="margin-top:14px">${esc(t.code)}</div>
      <p class="muted" style="font-size:13px;margin-top:12px">${t.startsAt ? esc(fDay(t.startsAt)) + ' · ' + esc(fTime(t.startsAt)) + ' · ' : ''}${esc(t.venue || t.city)}${t.from ? ` · from @${esc(t.from)}` : ''}</p>
      <p class="muted" style="font-size:12px;margin-top:8px">Turn your brightness up at the door. Each code scans once.</p>
    </div>
    <div class="modal-f">${t.eventId ? `<a class="btn ghost" href="#/e/${esc(t.eventId)}">Event</a>` : ''}${live ? '<button class="btn solid" id="give">Send to a friend</button>' : ''}</div>`);
  m.el.querySelector('a')?.addEventListener('click', () => m.close());
  const give = m.el.querySelector('#give');
  if (give) give.onclick = () => {
    $('.modal-b', m.el).innerHTML = `<label class="field" style="text-align:left"><span>Friend’s handle</span><input class="input" id="to" placeholder="@handle"></label><p class="muted" style="font-size:13px;text-align:left">They get a fresh code and this one stops working.</p>`;
    $('.modal-f', m.el).innerHTML = '<button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="send">Send ticket</button>';
    $('[data-close]', m.el).onclick = m.close;
    $('#send', m.el).onclick = ev => busy(ev.currentTarget, async () => {
      try { await api(`/api/tickets/${t.id}/transfer`, { method: 'POST', body: { toHandle: $('#to', m.el).value } }); m.close(); toast('Ticket sent.'); refresh(); }
      catch (e) { fail(e); }
    });
  };
}

// ── earn ─────────────────────────────────────────────
let stepSensor = null;
export async function earnView(el) {
  if (!state.user) return needLogin('earn');
  let ads = [], steps = { steps: 0, claimed: [], rewards: {} }, board = [];
  const load = async () => { [{ ads }, steps, { leaderboard: board }] = await Promise.all([api('/api/ads'), api('/api/steps/today'), api('/api/steps/leaderboard')]); };
  try { await load(); } catch (e) { el.innerHTML = `<div class="wrap empty">${esc(e.message)}</div>`; return; }
  const draw = () => {
    const mine = ads.filter(a => a.mine), others = ads.filter(a => !a.mine);
    el.innerHTML = `<div class="wrap"><div class="page-h"><div class="kicker">Wallet</div><div class="page-h-row"><h1 class="h-1">Earn NKT</h1><a class="btn ghost" href="#/wallet">${icon('back')}Wallet</a></div></div>
      <div class="split" style="padding:40px 0 80px"><div>
        <div class="label muted" style="margin-bottom:14px">Sponsored cards</div>
        <p class="muted" style="font-size:14px;margin-bottom:18px">Promoters fund these. Read one for eight seconds and the reward is yours — once per card.</p>
        ${others.length ? others.map(a => `<div class="req" style="grid-template-columns:1fr auto"><div><b>${esc(a.title)}</b><div class="muted" style="font-size:13px;margin-top:4px">${esc(a.body)} · @${esc(a.by)}</div></div><button class="btn sm solid" data-watch="${esc(a.id)}">+${nkt(a.rewardPerView)}</button></div>`).join('') : '<p class="muted">No cards running right now.</p>'}
        <div class="label muted" style="margin:40px 0 14px">Your cards</div>
        ${mine.map(a => `<div class="list-row"><div class="t"><b>${esc(a.title)}</b><span>${nkt(a.spent)} of ${nkt(a.budget)} NKT used · ${nkt(a.rewardPerView)} per view</span></div><button class="btn sm ghost" data-end="${esc(a.id)}">End</button></div>`).join('') || '<p class="muted" style="font-size:14px">Fund a card to put your night in front of people in the city.</p>'}
        <button class="btn" style="margin-top:16px" id="newAd">${icon('plus')}New sponsored card</button>
      </div><aside>
        <div class="label muted" style="margin-bottom:14px">Steps today</div>
        <div class="bal" style="font-size:96px">${steps.steps.toLocaleString('en-US')}</div>
        <div class="facts" style="margin-top:20px">${Object.entries(steps.rewards).map(([ms, r]) => `<div class="fact"><dt>${Number(ms).toLocaleString('en-US')}</dt><dd style="display:flex;justify-content:space-between;align-items:center">+${nkt(r)} NKT ${steps.claimed.includes(+ms) ? '<span class="kicker">Claimed</span>' : steps.steps >= +ms ? `<button class="btn sm solid" data-claim="${ms}">Claim</button>` : ''}</dd></div>`).join('')}</div>
        <button class="btn block ${stepSensor ? 'on' : ''}" style="margin-top:16px" id="track">${icon('steps')}${stepSensor ? 'Counting steps' : 'Count steps on this phone'}</button>
        ${board.length ? `<div class="label muted" style="margin:36px 0 14px">Leaderboard</div>${board.map((b, i) => `<div class="list-row"><span class="num" style="width:22px">${i + 1}</span><div class="t"><b>@${esc(b.handle)}</b></div><span class="num">${b.steps.toLocaleString('en-US')}</span></div>`).join('')}` : ''}
      </aside></div></div>`;
    $$('[data-watch]', el).forEach(b => (b.onclick = () => watch(b)));
    $$('[data-end]', el).forEach(b => (b.onclick = async () => { try { const r = await api('/api/ads/' + b.dataset.end, { method: 'DELETE' }); toast(`Ended. ${nkt(r.refunded)} NKT returned.`); await load(); draw(); } catch (e) { fail(e); } }));
    $$('[data-claim]', el).forEach(b => (b.onclick = async () => { try { const r = await api('/api/steps/claim-milestone', { method: 'POST', body: { milestone: +b.dataset.claim } }); toast(`+${nkt(r.reward)} NKT`); await load(); draw(); } catch (e) { fail(e); } }));
    $('#newAd', el).onclick = newAd;
    $('#track', el).onclick = track;
  };
  function watch(b) {
    let s = 8;
    b.disabled = true;
    const t = setInterval(async () => {
      s--; b.textContent = s + 's';
      if (s <= 0) { clearInterval(t); try { const r = await api(`/api/ads/${b.dataset.watch}/watch`, { method: 'POST' }); toast(`+${nkt(r.reward)} NKT`); await load(); draw(); } catch (e) { fail(e); b.disabled = false; } }
    }, 1000);
  }
  function newAd() {
    const m = modal(`${modalHead('New sponsored card', 'Earn')}<form class="modal-b" id="af">
      <label class="field"><span>Title</span><input class="input" name="title" maxlength="80" required></label>
      <label class="field"><span>Text</span><input class="input" name="body" maxlength="300"></label>
      <label class="field"><span>Link</span><input class="input" name="link" placeholder="https://"></label>
      <div class="row"><label class="field"><span>Budget (NKT)</span><input class="input" name="budget" inputmode="decimal" value="10"></label><label class="field"><span>Per view</span><input class="input" name="rewardPerView" inputmode="decimal" value="0.05"></label></div>
      <p class="muted" style="font-size:12px">The budget is held from your balance. End the card any time to get the unspent part back.</p></form>
      <div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn solid" id="go">Fund card</button></div>`);
    $('#go', m.el).onclick = ev => { const f = $('#af', m.el); if (!f.reportValidity()) return; busy(ev.currentTarget, async () => { try { await api('/api/ads', { method: 'POST', body: Object.fromEntries(new FormData(f)), idem: true }); m.close(); await load(); draw(); } catch (e) { fail(e); } }); };
  }
  async function track() {
    if (stepSensor) return;
    if (typeof DeviceMotionEvent?.requestPermission === 'function') { try { if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return toast('Motion access is needed to count steps.', 'err'); } catch { return; } }
    if (!('ondevicemotion' in window)) return toast('This device has no motion sensor.', 'err');
    let last = 0, pending = 0, lastPeak = 0;
    stepSensor = e => {
      const a = e.accelerationIncludingGravity; if (!a) return;
      const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      const now = Date.now();
      if (mag > 11.5 && last <= 11.5 && now - lastPeak > 280) { pending++; lastPeak = now; }
      last = mag;
    };
    window.addEventListener('devicemotion', stepSensor);
    setInterval(async () => { if (pending > 0) { const d = Math.min(pending, 2000); pending = 0; try { steps.steps = (await api('/api/steps', { method: 'POST', body: { delta: d } })).steps; } catch { /* retry next tick */ } } }, 20000);
    toast('Counting while this page is open.');
    draw();
  }
  draw();
}

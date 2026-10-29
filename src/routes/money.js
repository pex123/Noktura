// Wallet: balance & history, sending, requests & splits, PayPal top-ups and
// withdrawals, and paid promotion of posts, pins, events and listings.
const express = require('express');
const db = require('../db');
const paypal = require('../paypal');
const { requireAuth, verifyPassword } = require('../auth');
const { route, str, int, httpError, limit, amountOf, idempotent, money } = require('../lib');
const rt = require('../realtime');
const { debit, credit, ledger, transfer, assertDailyLimit, PLATFORM_FEE_PCT, MAX_TRANSFER, DAILY_OUT_LIMIT, PROMO_PRICES } = require('../ledger');
const { userByHandle } = require('./people');

const r = express.Router();
const CONFIRM_ABOVE = Number(process.env.CONFIRM_PASSWORD_ABOVE || 300);
const baseUrl = req => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

const txOut = (t, me) => ({ id: t.id, amount: money(t.amount), type: t.type, note: t.note, from: t.from_label, to: t.to_label, direction: t.to_user_id === me ? 'in' : 'out', at: Number(t.created_at) });
const reqOut = (q, me) => ({ id: q.id, amount: money(q.amount), note: q.note, status: q.status, from: q.from_handle, to: q.to_handle, incoming: q.to_user_id === me, groupId: q.group_id, at: Number(q.created_at) });

r.get('/wallet', requireAuth, route(async (req, res) => {
  const me = req.user.id;
  const before = Number(req.query.before) || Date.now() + 1;
  const [bal, txs, reqs] = await Promise.all([
    db.one('SELECT balance FROM users WHERE id = $1', [me]),
    db.all('SELECT * FROM transactions WHERE (from_user_id = $1 OR to_user_id = $1) AND created_at < $2 ORDER BY created_at DESC LIMIT 60', [me, before]),
    db.all(`SELECT q.*, f.handle AS from_handle, t.handle AS to_handle FROM payment_requests q JOIN users f ON f.id = q.from_user_id JOIN users t ON t.id = q.to_user_id
      WHERE (q.to_user_id = $1 OR q.from_user_id = $1) AND (q.status = 'open' OR q.settled_at > $2) ORDER BY q.created_at DESC LIMIT 60`, [me, Date.now() - 7 * 86400000]),
  ]);
  res.json({
    balance: money(bal.balance), currency: 'NKT', peg: 'USD', paypalConfigured: paypal.configured(),
    limits: { maxTransfer: MAX_TRANSFER, dailyOut: DAILY_OUT_LIMIT, confirmAbove: CONFIRM_ABOVE }, feePct: PLATFORM_FEE_PCT, promoPrices: PROMO_PRICES,
    transactions: txs.map(t => txOut(t, me)), nextBefore: txs.length === 60 ? Number(txs[txs.length - 1].created_at) : null,
    requests: reqs.map(q => reqOut(q, me)),
  });
}));

// Send NKT — friends, the person behind the bar, whoever is covering the round.
r.post('/wallet/transfer', requireAuth, limit('transfer', 30, 60000), idempotent(async (req, res) => {
  const b = req.body || {};
  const amount = amountOf(b.amount, { min: 0.5, max: MAX_TRANSFER });
  if (amount >= CONFIRM_ABOVE) await verifyPassword(req.user, b.password);
  const target = await userByHandle(b.toHandle);
  if (!target) throw httpError(404, 'No one goes by that handle.');
  if (await rt.blockedBetween(req.user.id, target.id)) throw httpError(403, 'You can’t pay this person.');
  const note = str(b.note, 140);
  const { balance } = await db.tx(c => transfer(c, { from: req.user, to: target, amount, note }));
  await rt.notify(target.id, 'payment', { from: req.user.handle, amount, message: `@${req.user.handle} sent you ${amount.toFixed(2)} NKT${note ? ': ' + note : '.'}` });
  rt.toUser(target.id, 'wallet_update', { reason: 'received', amount, from: req.user.handle });
  res.json({ ok: true, balance });
}));

// Requests and splits: ask one person, or split a bill across several.
r.post('/wallet/requests', requireAuth, limit('request', 30, 600000), route(async (req, res) => {
  const b = req.body || {};
  const handles = [...new Set((Array.isArray(b.toHandles) ? b.toHandles : [b.toHandle]).filter(Boolean).map(String))].slice(0, 30);
  if (!handles.length) throw httpError(400, 'Choose who to ask.');
  const people = [];
  for (const h of handles) {
    const u = await userByHandle(h);
    if (!u || u.is_demo || u.id === req.user.id) throw httpError(404, `@${String(h).replace(/^@/, '')} can’t receive requests.`);
    if (await rt.blockedBetween(req.user.id, u.id)) throw httpError(403, `You can’t send requests to @${u.handle}.`);
    people.push(u);
  }
  let each;
  if (b.split) {
    const total = amountOf(b.total, { min: 1, max: 20000, label: 'total' });
    const shares = people.length + (b.includeMe === false ? 0 : 1);
    each = Math.floor((total / shares) * 100) / 100;
    if (each < 0.5) throw httpError(400, 'Each share would be under 0.50 NKT.');
  } else each = amountOf(b.amount, { min: 0.5, max: MAX_TRANSFER });
  const note = str(b.note, 140);
  const groupId = people.length > 1 ? db.uid('split') : null;
  await db.tx(async c => {
    for (const u of people) {
      await c.query('INSERT INTO payment_requests (id, from_user_id, to_user_id, amount, note, group_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [db.uid('preq'), req.user.id, u.id, each, note, groupId, Date.now()]);
    }
  });
  for (const u of people) await rt.notify(u.id, 'request', { from: req.user.handle, amount: each, message: `@${req.user.handle} requested ${each.toFixed(2)} NKT${note ? ' for ' + note : ''}.` });
  res.status(201).json({ ok: true, each, count: people.length });
}));

async function openRequest(id, c) {
  const q = await db.one(`SELECT q.*, f.handle AS from_handle FROM payment_requests q JOIN users f ON f.id = q.from_user_id WHERE q.id = $1 FOR UPDATE OF q`, [id], c);
  if (!q) throw httpError(404, 'Request not found.');
  if (q.status !== 'open') throw httpError(409, `This request was already ${q.status}.`);
  return q;
}
r.post('/wallet/requests/:id/pay', requireAuth, limit('transfer', 30, 60000), idempotent(async (req, res) => {
  const out = await db.tx(async c => {
    const q = await openRequest(req.params.id, c);
    if (q.to_user_id !== req.user.id) throw httpError(403, 'This request is not addressed to you.');
    const amount = money(q.amount);
    if (amount >= CONFIRM_ABOVE) await verifyPassword(req.user, req.body?.password);
    const to = await db.one('SELECT * FROM users WHERE id = $1', [q.from_user_id], c);
    const { balance } = await transfer(c, { from: req.user, to, amount, note: q.note || 'Request', type: 'request_paid', ref: q.id });
    await c.query("UPDATE payment_requests SET status = 'paid', settled_at = $2 WHERE id = $1", [q.id, Date.now()]);
    return { q, amount, balance };
  });
  await rt.notify(out.q.from_user_id, 'payment', { from: req.user.handle, amount: out.amount, message: `@${req.user.handle} paid your request of ${out.amount.toFixed(2)} NKT.` });
  rt.toUser(out.q.from_user_id, 'wallet_update', { reason: 'request_paid' });
  res.json({ ok: true, balance: out.balance });
}));
r.post('/wallet/requests/:id/:action(decline|cancel)', requireAuth, route(async (req, res) => {
  const action = req.params.action;
  const q = await db.tx(async c => {
    const q = await openRequest(req.params.id, c);
    if (action === 'decline' && q.to_user_id !== req.user.id) throw httpError(403, 'This request is not addressed to you.');
    if (action === 'cancel' && q.from_user_id !== req.user.id) throw httpError(403, 'Only the sender can cancel a request.');
    await c.query('UPDATE payment_requests SET status = $2, settled_at = $3 WHERE id = $1', [q.id, action === 'decline' ? 'declined' : 'cancelled', Date.now()]);
    return q;
  });
  if (action === 'decline') await rt.notify(q.from_user_id, 'system', { message: `@${req.user.handle} declined your request of ${money(q.amount).toFixed(2)} NKT.` });
  res.json({ ok: true });
}));

// ── PayPal ─────────────────────────────────────────────
r.post('/wallet/paypal/create-order', requireAuth, limit('topup', 10, 600000), route(async (req, res) => {
  const amount = amountOf(req.body?.amount, { min: 1, max: 1000 });
  const base = baseUrl(req);
  const { orderId, approveUrl } = await paypal.createOrder({ amount, description: `NOKTURA top-up for @${req.user.handle}`, returnUrl: base + '/paypal-return.html', cancelUrl: base + '/paypal-return.html?cancelled=1' });
  await db.query("INSERT INTO payment_orders (id, user_id, kind, provider, amount, created_at, expires_at) VALUES ($1,$2,'topup','paypal',$3,$4,$5)", [orderId, req.user.id, amount, Date.now(), Date.now() + 3 * 3600000]);
  res.json({ orderId, approveUrl });
}));
r.post('/wallet/paypal/capture/:orderId', requireAuth, limit('capture', 30, 60000), route(async (req, res) => {
  const order = await db.one("SELECT * FROM payment_orders WHERE id = $1 AND user_id = $2 AND kind = 'topup'", [req.params.orderId, req.user.id]);
  if (!order) throw httpError(404, 'Top-up not found.');
  if (order.status === 'captured') return res.json({ credited: money(order.amount), alreadyCredited: true });
  const claimed = await db.one("UPDATE payment_orders SET status = 'capturing' WHERE id = $1 AND status = 'pending' RETURNING id", [order.id]);
  if (!claimed) throw httpError(409, 'This top-up is already being processed.');
  let paid;
  try { paid = await paypal.captureOrder(order.id); }
  catch (e) { await db.query("UPDATE payment_orders SET status = 'pending' WHERE id = $1 AND status = 'capturing'", [order.id]); throw e; }
  const credited = money(Math.min(paid, money(order.amount)));
  let balance;
  await db.tx(async c => {
    balance = await credit(c, req.user.id, credited);
    await ledger(c, { toId: req.user.id, fromLabel: 'PayPal', toLabel: req.user.handle, amount: credited, type: 'paypal_topup', note: 'PayPal top-up', ref: order.id });
    await c.query("UPDATE payment_orders SET status = 'captured', captured_at = $2 WHERE id = $1", [order.id, Date.now()]);
  });
  res.json({ credited, balance });
}));
r.post('/wallet/paypal/payout', requireAuth, limit('payout', 5, 3600000), route(async (req, res) => {
  if (!paypal.configured()) throw httpError(503, 'Withdrawals are not switched on yet. Nothing was taken from your balance.');
  await verifyPassword(req.user, req.body?.password);
  const amount = amountOf(req.body?.amount, { min: 5, max: 5000 });
  const email = str(req.body?.paypalEmail, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw httpError(400, 'Enter the email address of your PayPal account.');
  const txId = await db.tx(async c => {
    await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    await assertDailyLimit(c, req.user.id, amount);
    await debit(c, req.user.id, amount);
    return ledger(c, { fromId: req.user.id, fromLabel: req.user.handle, toLabel: 'PayPal', amount, type: 'paypal_payout_pending', note: 'Withdrawal to ' + email.replace(/(.).+(@.+)/, '$1•••$2') });
  });
  try {
    const batchId = await paypal.payout({ amount, email, note: 'Your NOKTURA withdrawal', senderItemId: txId });
    await db.query("UPDATE transactions SET type = 'paypal_payout', external_ref = $2 WHERE id = $1", [txId, batchId]);
    res.json({ ok: true, batchId });
  } catch (e) {
    await db.tx(async c => {
      await c.query('DELETE FROM transactions WHERE id = $1', [txId]);
      await credit(c, req.user.id, amount);
    });
    throw httpError(e.status || 502, (e.message || 'PayPal payout failed.') + ' Your balance was not charged.');
  }
}));

// ── promotion ──────────────────────────────────────────
const TARGETS = {
  post: { table: 'posts', owner: 'user_id', label: 'post' },
  pin: { table: 'pins', owner: 'user_id', label: 'map pin' },
  event: { table: 'events', owner: 'user_id', label: 'event' },
  listing: { table: 'market_items', owner: 'seller_id', label: 'listing' },
};
r.get('/promote/prices', (req, res) => res.json({ prices: PROMO_PRICES, days: [1, 3, 7, 14, 30] }));
r.post('/promote', requireAuth, limit('promote', 20, 3600000), idempotent(async (req, res) => {
  const t = TARGETS[req.body?.targetType];
  if (!t) throw httpError(400, 'Choose what to promote.');
  const days = int(req.body?.days, { min: 1, max: 30, fallback: 1 });
  const id = str(req.body?.targetId, 60);
  const cost = money(PROMO_PRICES[req.body.targetType] * days);
  const out = await db.tx(async c => {
    const row = await db.one(`SELECT id, promoted_until FROM ${t.table} WHERE id = $1 AND ${t.owner} = $2 FOR UPDATE`, [id, req.user.id], c);
    if (!row) throw httpError(404, `You can only promote your own ${t.label}.`);
    const from = Math.max(Date.now(), Number(row.promoted_until || 0));
    const until = from + days * 86400000;
    const balance = await debit(c, req.user.id, cost);
    await ledger(c, { fromId: req.user.id, fromLabel: req.user.handle, toLabel: 'NOKTURA', amount: cost, type: 'promotion', note: `Promote ${t.label} · ${days} day${days > 1 ? 's' : ''}`, ref: id });
    await c.query(`UPDATE ${t.table} SET promoted_until = $2 WHERE id = $1`, [id, until]);
    await c.query('INSERT INTO promotions (id, user_id, target_type, target_id, days, amount, starts_at, ends_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [db.uid('promo'), req.user.id, req.body.targetType, id, days, cost, from, until, Date.now()]);
    return { until, balance };
  });
  res.json({ ok: true, promotedUntil: out.until, balance: out.balance, cost });
}));

module.exports = { router: r };

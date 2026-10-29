// Balance changes. Every function takes a transaction client so the debit,
// the credit and the ledger row commit or roll back together. Balances can
// never go negative: the debit is a single conditional UPDATE and the column
// carries CHECK (balance >= 0) as a second line of defence.
const db = require('./db');
const { httpError, money } = require('./lib');

const PLATFORM_FEE_PCT = Math.max(0, Math.min(30, Number(process.env.PLATFORM_FEE_PCT ?? 5)));
const MAX_TRANSFER = Number(process.env.MAX_TRANSFER || 2000);
const DAILY_OUT_LIMIT = Number(process.env.DAILY_OUT_LIMIT || 5000);
const PROMO_PRICES = {
  post: Number(process.env.PROMO_PRICE_POST || 2),
  pin: Number(process.env.PROMO_PRICE_PIN || 2),
  listing: Number(process.env.PROMO_PRICE_LISTING || 1.5),
  event: Number(process.env.PROMO_PRICE_EVENT || 5),
};

async function debit(client, userId, amount) {
  const r = await db.one('UPDATE users SET balance = balance - $2 WHERE id = $1 AND balance >= $2 RETURNING balance', [userId, amount], client);
  if (!r) throw httpError(400, 'Not enough NKT. Top up your wallet first.', 'insufficient_funds');
  return money(r.balance);
}
async function credit(client, userId, amount) {
  const r = await db.one('UPDATE users SET balance = balance + $2 WHERE id = $1 RETURNING balance', [userId, amount], client);
  if (!r) throw httpError(404, 'Account not found.');
  return money(r.balance);
}
async function ledger(client, { fromId = null, toId = null, fromLabel, toLabel, amount, type, note = '', ref = null }) {
  const id = db.uid('tx');
  await client.query(`INSERT INTO transactions (id, from_user_id, to_user_id, from_label, to_label, amount, type, note, external_ref, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, fromId, toId, fromLabel, toLabel, amount, type, String(note).slice(0, 200), ref, Date.now()]);
  return id;
}

// Outgoing peer-to-peer volume over the last 24 h, checked before each send.
async function assertDailyLimit(client, userId, amount) {
  const r = await db.one(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions
    WHERE from_user_id = $1 AND type IN ('transfer','request_paid','paypal_payout','paypal_payout_pending') AND created_at > $2`, [userId, Date.now() - 86400000], client);
  if (money(r.total) + amount > DAILY_OUT_LIMIT) throw httpError(400, `Daily sending limit is ${DAILY_OUT_LIMIT.toFixed(2)} NKT.`);
}

// Peer transfer used by Send, Pay QR, chat payments and accepted requests.
async function transfer(client, { from, to, amount, note, type = 'transfer', ref = null }) {
  if (to.id === from.id) throw httpError(400, "You can't send NKT to yourself.");
  if (to.is_demo) throw httpError(400, `@${to.handle} can't receive NKT.`);
  if (amount > MAX_TRANSFER) throw httpError(400, `The most you can send at once is ${MAX_TRANSFER.toFixed(2)} NKT.`);
  // Lock both rows in a fixed order so two opposite transfers can't deadlock.
  await client.query('SELECT id FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[from.id, to.id]]);
  await assertDailyLimit(client, from.id, amount);
  const balance = await debit(client, from.id, amount);
  await credit(client, to.id, amount);
  const txId = await ledger(client, { fromId: from.id, toId: to.id, fromLabel: from.handle, toLabel: to.handle, amount, type, note, ref });
  return { balance, txId };
}

const feeOn = amount => money(amount * PLATFORM_FEE_PCT / 100);

module.exports = { debit, credit, ledger, transfer, feeOn, assertDailyLimit, PLATFORM_FEE_PCT, MAX_TRANSFER, DAILY_OUT_LIMIT, PROMO_PRICES };

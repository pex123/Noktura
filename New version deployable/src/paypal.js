// Minimal PayPal REST client: Orders v2 (checkout/top-up) and Payouts v1 (withdrawals).
const crypto = require('crypto');
const { httpError } = require('./auth');

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const SECRET = process.env.PAYPAL_CLIENT_SECRET;
const BASE = process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const configured = () => !!(CLIENT_ID && SECRET);
let cachedToken = null;

function ensureConfigured() {
  if (!configured()) throw httpError(503, 'PayPal is not configured on this server yet. No charge was made.');
}

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.value;
  const r = await fetch(BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(CLIENT_ID + ':' + SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(502, 'PayPal authentication failed. Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.');
  cachedToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function call(method, path, body, idempotencyKey) {
  ensureConfigured();
  const headers = { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['PayPal-Request-Id'] = idempotencyKey;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data.details?.[0]?.description || data.message || ('HTTP ' + r.status);
    const err = httpError(r.status >= 500 ? 502 : 400, 'PayPal: ' + detail);
    err.paypal = data;
    throw err;
  }
  return data;
}

async function createOrder({ amount, description, returnUrl, cancelUrl }) {
  const order = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{ amount: { currency_code: 'USD', value: amount.toFixed(2) }, description: description.slice(0, 127) }],
    application_context: { brand_name: 'NOKTURA', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: returnUrl, cancel_url: cancelUrl },
  }, crypto.randomUUID());
  const approve = (order.links || []).find(l => l.rel === 'approve' || l.rel === 'payer-action');
  return { orderId: order.id, approveUrl: approve?.href };
}

// Captures an approved order. Returns the captured USD amount; throws if not completed.
async function captureOrder(orderId) {
  let data;
  try {
    data = await call('POST', '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {}, 'capture-' + orderId);
  } catch (e) {
    if (e.paypal?.details?.[0]?.issue === 'ORDER_ALREADY_CAPTURED') data = await call('GET', '/v2/checkout/orders/' + encodeURIComponent(orderId));
    else if (e.paypal?.details?.[0]?.issue === 'ORDER_NOT_APPROVED') throw httpError(400, 'Approve the payment in the PayPal tab first, then tap Finish.');
    else throw e;
  }
  if (data.status !== 'COMPLETED') throw httpError(400, 'Payment not completed yet (status: ' + data.status + ').');
  const cap = data.purchase_units?.[0]?.payments?.captures?.[0];
  if (!cap || cap.status !== 'COMPLETED' || cap.amount?.currency_code !== 'USD') throw httpError(400, 'PayPal did not confirm the payment.');
  return Number(cap.amount.value);
}

async function payout({ amount, email, note, senderItemId }) {
  const data = await call('POST', '/v1/payments/payouts', {
    sender_batch_header: { sender_batch_id: senderItemId, email_subject: 'You have a payout from NOKTURA', email_message: note },
    items: [{ recipient_type: 'EMAIL', amount: { value: amount.toFixed(2), currency: 'USD' }, receiver: email, note, sender_item_id: senderItemId }],
  }, senderItemId);
  return data.batch_header?.payout_batch_id;
}

module.exports = { configured, createOrder, captureOrder, payout };

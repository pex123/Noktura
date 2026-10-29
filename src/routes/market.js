// Marketplace (buy with NKT), sponsored cards that pay viewers, step rewards.
const express = require('express');
const db = require('../db');
const { requireAuth, optionalAuth } = require('../auth');
const { route, str, httpError, limit, amountOf, httpUrl, idempotent, money } = require('../lib');
const rt = require('../realtime');
const { debit, credit, ledger, feeOn } = require('../ledger');

const r = express.Router();
const CATEGORIES = new Set(['tickets', 'gear', 'clothing', 'art', 'records', 'services', 'other']);
const CONDITIONS = new Set(['new', 'like new', 'good', 'used', '']);

const itemOut = (i, me) => ({
  id: i.id, category: i.category, title: i.title, description: i.description, price: money(i.price_axc), city: i.city, condition: i.condition,
  image: i.image_upload ? '/api/uploads/' + i.image_upload : '', status: i.status,
  seller: { handle: i.handle, avatar: i.avatar, verified: !!i.is_verified }, mine: !!me && i.seller_id === me,
  promoted: !!(i.promoted_until && Number(i.promoted_until) > Date.now()), createdAt: Number(i.created_at),
});

r.get('/market', optionalAuth, route(async (req, res) => {
  const me = req.user?.id;
  const params = [Date.now()];
  const where = ["m.status = 'active'", 'u.suspended_at IS NULL'];
  const cat = str(req.query.category, 20);
  if (CATEGORIES.has(cat)) { params.push(cat); where.push(`m.category = $${params.length}`); }
  if (req.query.city) { params.push(str(req.query.city, 60)); where.push(`(lower(m.city) = lower($${params.length}) OR m.city = '')`); }
  const term = str(req.query.q, 60).toLowerCase().replace(/[%_\\]/g, x => '\\' + x);
  if (term) { params.push('%' + term + '%'); where.push(`(lower(m.title) LIKE $${params.length} OR lower(m.description) LIKE $${params.length})`); }
  if (req.query.mine === '1' && me) { params.push(me); where.splice(0, 1, `m.status <> 'removed'`); where.push(`m.seller_id = $${params.length}`); }
  const rows = await db.all(`SELECT m.*, u.handle, u.avatar, u.is_verified FROM market_items m JOIN users u ON u.id = m.seller_id
    WHERE ${where.join(' AND ')} ORDER BY (m.promoted_until IS NOT NULL AND m.promoted_until > $1) DESC, m.created_at DESC LIMIT 200`, params);
  res.json({ items: rows.map(i => itemOut(i, me)) });
}));
r.post('/market', requireAuth, limit('listing', 20, 3600000), route(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 100);
  if (title.length < 3) throw httpError(400, 'Give the item a title.');
  const price = amountOf(b.price ?? b.priceAxc, { min: 0.5, max: 50000, label: 'price' });
  const imageUpload = b.imageUpload && (await db.one("SELECT 1 FROM uploads WHERE id = $1 AND user_id = $2 AND content_type LIKE 'image/%'", [b.imageUpload, req.user.id])) ? b.imageUpload : null;
  const id = db.uid('mkt');
  await db.query(`INSERT INTO market_items (id, seller_id, category, title, description, price_axc, city, condition, image_upload, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, req.user.id, CATEGORIES.has(b.category) ? b.category : 'other', title, str(b.description, 1500), price,
    str(b.city, 60) || req.user.city, CONDITIONS.has(b.condition) ? b.condition : '', imageUpload, Date.now()]);
  res.status(201).json({ ok: true, id });
}));
r.delete('/market/:id', requireAuth, route(async (req, res) => {
  const d = await db.query("UPDATE market_items SET status = 'removed' WHERE id = $1 AND seller_id = $2 AND status = 'active'", [req.params.id, req.user.id]);
  if (!d.rowCount) throw httpError(404, 'Listing not found.');
  res.json({ ok: true });
}));
// Buying moves NKT buyer → seller atomically; the platform keeps its fee.
r.post('/market/:id/buy', requireAuth, limit('buy', 20, 60000), idempotent(async (req, res) => {
  const out = await db.tx(async c => {
    const item = await db.one('SELECT m.*, u.handle, u.is_demo FROM market_items m JOIN users u ON u.id = m.seller_id WHERE m.id = $1 FOR UPDATE OF m', [req.params.id], c);
    if (!item || item.status !== 'active') throw httpError(404, 'This listing is no longer available.');
    if (item.seller_id === req.user.id) throw httpError(400, 'This is your own listing.');
    if (await rt.blockedBetween(req.user.id, item.seller_id)) throw httpError(403, 'You can’t buy from this seller.');
    const price = money(item.price_axc), fee = feeOn(price);
    const balance = await debit(c, req.user.id, price);
    await credit(c, item.seller_id, money(price - fee));
    await ledger(c, { fromId: req.user.id, toId: item.seller_id, fromLabel: req.user.handle, toLabel: item.handle, amount: money(price - fee), type: 'market_purchase', note: item.title, ref: item.id });
    if (fee > 0) await ledger(c, { fromId: req.user.id, fromLabel: req.user.handle, toLabel: 'NOKTURA', amount: fee, type: 'market_fee', note: 'Service fee: ' + item.title, ref: item.id });
    await c.query("UPDATE market_items SET status = 'sold', buyer_id = $2, sold_at = $3 WHERE id = $1", [item.id, req.user.id, Date.now()]);
    return { item, price, fee, balance };
  });
  await rt.notify(out.item.seller_id, 'sale', { from: req.user.handle, amount: out.price, message: `@${req.user.handle} bought “${out.item.title}” — ${money(out.price - out.fee).toFixed(2)} NKT is in your wallet. Message them to arrange hand-over.` });
  rt.toUser(out.item.seller_id, 'wallet_update', { reason: 'sale' });
  res.json({ ok: true, balance: out.balance, seller: out.item.handle });
}));

// ── sponsored cards (funded by the advertiser, each view pays the viewer) ──
r.get('/ads', requireAuth, route(async (req, res) => {
  const rows = await db.all(`SELECT a.*, u.handle FROM ads a JOIN users u ON u.id = a.user_id
    WHERE (a.budget - a.spent >= a.reward_per_view AND NOT EXISTS (SELECT 1 FROM ad_views v WHERE v.ad_id = a.id AND v.user_id = $1)) OR a.user_id = $1
    ORDER BY a.created_at DESC LIMIT 50`, [req.user.id]);
  res.json({ ads: rows.map(a => ({ id: a.id, title: a.title, body: a.body, link: a.link, budget: money(a.budget), spent: money(a.spent), rewardPerView: money(a.reward_per_view), by: a.handle, mine: a.user_id === req.user.id })) });
}));
r.post('/ads', requireAuth, limit('ad', 10, 3600000), idempotent(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 80);
  if (!title) throw httpError(400, 'Give the card a title.');
  const budget = amountOf(b.budget, { min: 1, max: 10000, label: 'budget' });
  const reward = Number(b.rewardPerView) > 0 ? amountOf(b.rewardPerView, { min: 0.01, max: Math.min(1, budget), label: 'reward' }) : Math.min(0.05, budget);
  const id = db.uid('ad');
  await db.tx(async c => {
    await debit(c, req.user.id, budget);
    await ledger(c, { fromId: req.user.id, fromLabel: req.user.handle, toLabel: 'NOKTURA', amount: budget, type: 'ad_budget_hold', note: 'Sponsored card: ' + title });
    await c.query('INSERT INTO ads (id, user_id, title, body, link, budget, reward_per_view, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, req.user.id, title, str(b.body, 300), httpUrl(b.link), budget, reward, Date.now()]);
  });
  res.status(201).json({ ok: true, id });
}));
// Ending a card early returns whatever budget is left.
r.delete('/ads/:id', requireAuth, route(async (req, res) => {
  const refund = await db.tx(async c => {
    const ad = await db.one('SELECT * FROM ads WHERE id = $1 AND user_id = $2 FOR UPDATE', [req.params.id, req.user.id], c);
    if (!ad) throw httpError(404, 'Card not found.');
    const left = money(money(ad.budget) - money(ad.spent));
    if (left > 0) {
      await credit(c, req.user.id, left);
      await ledger(c, { toId: req.user.id, fromLabel: 'NOKTURA', toLabel: req.user.handle, amount: left, type: 'ad_budget_refund', note: 'Unspent budget: ' + ad.title });
    }
    await c.query('UPDATE ads SET budget = spent WHERE id = $1', [ad.id]);
    return left;
  });
  res.json({ ok: true, refunded: refund });
}));
r.post('/ads/:id/watch', requireAuth, limit('ad-watch', 30, 3600000), route(async (req, res) => {
  const recent = await db.one('SELECT MAX(created_at) AS at FROM ad_views WHERE user_id = $1', [req.user.id]);
  if (recent?.at && Date.now() - Number(recent.at) < 8000) throw httpError(429, 'Watch the full card to earn.');
  let reward;
  await db.tx(async c => {
    const ad = await db.one('SELECT * FROM ads WHERE id = $1 FOR UPDATE', [req.params.id], c);
    if (!ad) throw httpError(404, 'This card is no longer running.');
    if (ad.user_id === req.user.id) throw httpError(400, "You can't earn from your own card.");
    reward = money(ad.reward_per_view);
    if (money(ad.budget) - money(ad.spent) < reward) throw httpError(400, 'This card has run out of budget.');
    const v = await c.query('INSERT INTO ad_views (ad_id, user_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ad.id, req.user.id, Date.now()]);
    if (!v.rowCount) throw httpError(400, 'Already claimed.');
    await c.query('UPDATE ads SET spent = spent + $2 WHERE id = $1', [ad.id, reward]);
    await credit(c, req.user.id, reward);
    await ledger(c, { toId: req.user.id, fromLabel: 'NOKTURA', toLabel: req.user.handle, amount: reward, type: 'ad_reward', note: 'Viewed: ' + ad.title });
  });
  res.json({ ok: true, reward });
}));

// ── steps ─────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
const STEP_REWARDS = { 2500: 0.1, 5000: 0.2, 7500: 0.3, 10000: 0.5 };
r.post('/steps', requireAuth, limit('steps', 120, 3600000), route(async (req, res) => {
  const delta = parseInt(req.body?.delta, 10);
  if (!(delta > 0 && delta <= 2000)) throw httpError(400, 'Invalid step count.');
  const s = await db.one(`INSERT INTO steps (user_id, day, steps) VALUES ($1,$2,LEAST($3, 60000))
    ON CONFLICT (user_id, day) DO UPDATE SET steps = LEAST(steps.steps + $3, 60000) RETURNING steps`, [req.user.id, today(), delta]);
  res.json({ steps: s.steps });
}));
r.get('/steps/today', requireAuth, route(async (req, res) => {
  const s = await db.one('SELECT steps FROM steps WHERE user_id = $1 AND day = $2', [req.user.id, today()]);
  const claimed = await db.all('SELECT milestone FROM step_claims WHERE user_id = $1 AND day = $2', [req.user.id, today()]);
  res.json({ steps: s ? s.steps : 0, claimed: claimed.map(c => c.milestone), rewards: STEP_REWARDS });
}));
r.get('/steps/leaderboard', requireAuth, route(async (req, res) => {
  const rows = await db.all('SELECT u.handle, u.avatar, s.steps FROM steps s JOIN users u ON u.id = s.user_id WHERE s.day = $1 AND s.steps > 0 ORDER BY s.steps DESC LIMIT 20', [today()]);
  res.json({ leaderboard: rows });
}));
r.post('/steps/claim-milestone', requireAuth, route(async (req, res) => {
  const milestone = parseInt(req.body?.milestone, 10);
  const reward = STEP_REWARDS[milestone];
  if (!reward) throw httpError(400, 'Unknown milestone.');
  const day = today();
  await db.tx(async c => {
    const s = await db.one('SELECT steps FROM steps WHERE user_id = $1 AND day = $2', [req.user.id, day], c);
    if (!s || s.steps < milestone) throw httpError(400, 'Not there yet — keep walking.');
    const ins = await c.query('INSERT INTO step_claims (user_id, day, milestone, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [req.user.id, day, milestone, Date.now()]);
    if (!ins.rowCount) throw httpError(400, 'Already claimed today.');
    await credit(c, req.user.id, reward);
    await ledger(c, { toId: req.user.id, fromLabel: 'NOKTURA', toLabel: req.user.handle, amount: reward, type: 'step_milestone', note: milestone.toLocaleString('en-US') + ' steps' });
  });
  res.json({ ok: true, reward });
}));

module.exports = { router: r };

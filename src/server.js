require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const compression = require('compression');
const db = require('./db');
const paypal = require('./paypal');
const rt = require('./realtime');
const sources = require('./sources');
const { seed } = require('./seed');
const { limit } = require('./lib');

const PROD = process.env.NODE_ENV === 'production';
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');
app.use(compression());

// ── security headers ───────────────────────────────────
const TILE_HOSTS = (process.env.TILE_URL || 'https://{s}.basemaps.cartocdn.com').match(/^https?:\/\/[^/]+/)?.[0].replace('{s}', '*') || '';
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "font-src 'self'",
  `connect-src 'self' wss: ws: https://nominatim.openstreetmap.org ${TILE_HOSTS}`,
  "frame-src https://www.paypal.com https://www.sandbox.paypal.com",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(self), accelerometer=(self), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
// Redirect plain HTTP to HTTPS behind Render/Heroku-style proxies.
if (PROD && process.env.FORCE_HTTPS !== 'false') {
  app.use((req, res, next) => (req.secure || req.path === '/api/health' ? next() : res.redirect(308, 'https://' + req.get('host') + req.originalUrl)));
}

const smallJson = express.json({ limit: '200kb' });
const uploadJson = express.json({ limit: '12mb' });
app.use('/api', (req, res, next) => (req.path === '/uploads' ? uploadJson : smallJson)(req, res, next));
// Blanket ceiling per IP on the API; individual routes set tighter ones.
app.use('/api', limit('api', Number(process.env.API_RATE_PER_MIN || 600), 60000));

// ── health & config ────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true, online: rt.onlineCount(), uptime: Math.round(process.uptime()) }); }
  catch (e) { res.status(503).json({ ok: false }); }
});
app.get('/config.js', (req, res) => {
  const cfg = {
    tileUrl: process.env.TILE_URL || 'https://{s}.basemaps.cartocdn.com/{theme}_all/{z}/{x}/{y}{r}.png',
    tileAttribution: process.env.TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
    paypal: paypal.configured(), support: process.env.SUPPORT_EMAIL || 'support@noktura.app',
    iceServers: process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : [{ urls: 'stun:stun.l.google.com:19302' }],
  };
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(`window.NOKTURA_CONFIG=${JSON.stringify(cfg).replace(/</g, '\\u003c')};`);
});

// ── API ────────────────────────────────────────────────
app.use('/api', require('./routes/people').router);
app.use('/api', require('./routes/chat').router);
app.use('/api', require('./routes/events').router);
app.use('/api', require('./routes/feed').router);
app.use('/api', require('./routes/money').router);
app.use('/api', require('./routes/market').router);
app.use('/api', require('./routes/map').router);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
  const status = err.status || 500;
  if (status >= 500) console.error(`[${req.method} ${req.path}]`, err);
  res.status(status).json({ error: status >= 500 && !err.status ? 'Something went wrong on our side. Try again.' : err.message, code: err.code });
});

// ── static site ────────────────────────────────────────
const PUBLIC = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC, {
  extensions: ['html'],
  setHeaders(res, file) {
    if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else if (/\/assets\/(fonts|vendor)\//.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
  },
}));
// The app uses hash routes; anything else that isn't a file gets the shell.
app.get(/^\/(?!api\/|assets\/|socket\.io\/).*/, (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// ── boot ───────────────────────────────────────────────
const server = http.createServer(app);
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
rt.attach(server);

const PORT = process.env.PORT || 4000;
(async () => {
  await db.migrate();
  await seed();
  server.listen(PORT, () => console.log(`[noktura] listening on :${PORT} · PayPal ${paypal.configured() ? 'on' : 'off'} · Ticketmaster ${process.env.TICKETMASTER_API_KEY ? 'on' : 'off'}`));
  sources.startGeocoder();
})().catch(e => {
  console.error('[noktura] failed to start:', e);
  process.exit(1);
});

const shutdown = sig => {
  console.log(`[noktura] ${sig} — draining`);
  server.close(() => db.pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => console.error('[noktura] unhandled rejection', e));

module.exports = { app, server };

# NOKTURA

Events, tickets, friends and payments for nights out — Belgrade, Novi Sad and cities worldwide.

One Node service (Express + Socket.IO) serves the site and the API, backed by PostgreSQL (Supabase or Render Postgres). No build step: the frontend is plain ES modules in `public/`.

## What's in it

| Area | What it does |
|---|---|
| **Events** | City page with date presets (tonight, tomorrow, weekend, week, month, any date), categories, search, "friends going", featured grid and a day-by-day agenda. Works for any place on Earth: the API filters by radius around the city's coordinates. |
| **Listings** | ~220 real events for Belgrade, Novi Sad, Berlin, London, New York, Amsterdam, Paris, Barcelona, Vienna, Zagreb and Budapest, collected 29 Oct 2026 from Resident Advisor, tickets.rs, Balkanrock, Songkick, Moj Novi Sad and others (`src/content/listings.js`). Each links to its source. With `TICKETMASTER_API_KEY` set, every city a user opens is refreshed from Ticketmaster automatically (every 6 h, 40 km radius). |
| **Ticketing** | Organisers post events with up to 8 tiers. Buyers pay from their wallet, with PayPal/card, or free. Seats are locked per tier in the database (no overselling under load); PayPal checkouts hold seats for 20 min. QR tickets, transfer to a friend (re-issues the code), door scanner with guest list, cancel-and-refund in one transaction. |
| **Social** | Two-way friends, close friends, RSVP going/interested, friends-going on every event, event group chats, city feed with photos, event cards, anonymous posts, comments, likes, delete, report, block. |
| **Map** | Monochrome map of the city's events plus people's event pins, meet-ups and live friend locations (opt-in, friends only, expires after 4 h). Drop, drag, delete and promote pins. |
| **Messages** | Realtime DMs and groups, typing, attachments, delete, mute, leave, block/report, send money inside a chat, audio/video calls (WebRTC). |
| **Wallet (NKT)** | 1 NKT = 1 USD prepaid credit. Send, request, split a bill, pay-by-QR (receive code with amount), "buy a round" presets, PayPal top-up and withdrawal, full history. |
| **Promotion** | Pay NKT per day to promote a post, pin, event or listing; promoted items are labelled and ranked first. Sponsored cards pay viewers per view. |
| **Market** | Listings with photos, buy with NKT (atomic, fee to platform), message seller, delete, promote, report. |
| **Accounts** | Sign-up with age and terms confirmation, profile photo/bio, change password, sign out everywhere, data export (GDPR), account deletion, admin moderation queue. |
| **Legal** | Terms, Privacy, Refunds, Community Guidelines, Organiser Terms at `/terms`, `/privacy`, `/refunds`, `/guidelines`, `/organisers`. |

## Security

- **Payments**: every balance change is a single DB transaction with row locks taken in a fixed order (no deadlocks, no negative balances — enforced by `CHECK (balance >= 0)` too). Money endpoints accept an `Idempotency-Key` (the client sends one per action), so retries and double taps never charge twice. Per-payment and daily limits; password re-entry above a threshold and for withdrawals. PayPal orders are captured server-side and the captured amount is checked against the order.
- **Auth**: bcrypt (cost 12), HS256 JWTs with a per-user token version (password change and "sign out everywhere" revoke all sessions), per-account login lockout stored in Postgres, rate limits per route.
- **Web**: strict Content-Security-Policy (no inline scripts), HSTS and HTTPS redirect in production, `X-Frame-Options: DENY`, nosniff, uploads checked against their magic bytes and served sandboxed.
- **Conversations**: membership checked on every read, send and call signal; blocking stops DMs, payments, comments and visibility; message flood limits on the socket.
- **Data**: Row Level Security is enabled on every table with no policies, so Supabase's public keys can't read anything; only the server (as owner) can.

## Scale

Checked locally: 20 parallel purchases against a 5-seat tier sold exactly 5. For 1,000+ people events and multiple cities:

- Run 2+ instances on Render and set `REDIS_URL` (Render Key Value) — Socket.IO then fans out across instances.
- Use Supabase's **Session pooler** URL and raise `DATABASE_POOL_SIZE` (15–20 per instance).
- Indexes cover the hot paths (events by time/geo/city, posts by city/time, chats, tickets).
- Uploads are stored in Postgres (8 MB cap). For heavy media move them to object storage (S3/R2) behind the same two endpoints in `src/routes/chat.js`.
- Calls use public STUN; add a TURN server in `ICE_SERVERS` so calls connect on strict mobile networks.

## Deploy on Render + Supabase

1. **Supabase** → New project → Connect → copy the **Session pooler** URI (`…pooler.supabase.com:5432/postgres`) and put your DB password in it.
2. **Render** → New → Blueprint → this repo. Fill `DATABASE_URL`, `PUBLIC_URL` (your domain) and, when ready, `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` and `TICKETMASTER_API_KEY`. `JWT_SECRET` is generated.
3. First boot applies `supabase/schema.sql`, creates the `@noktura` account, imports the launch listings and writes the city round-ups. `/api/health` reports status.
4. Set `ADMIN_HANDLES=yourhandle` and redeploy to get the moderation queue at `#/admin`.
5. Point your domain at Render (Settings → Custom domains). HTTPS is automatic.

Local:

```bash
cp .env.example .env    # set DATABASE_URL and JWT_SECRET
npm install
npm run dev             # http://localhost:4000
```

## Before you take real money

- Fill in the operator details marked `[OPERATOR LEGAL NAME]` etc. in `public/*.html` and have a lawyer review the Terms, Privacy Policy and Refund Policy for your company and the countries you operate in. A prepaid wallet that users can send to each other and withdraw can fall under e-money / payment-services rules (in Serbia the Law on Payment Services; in the EU PSD2/EMD2): confirm whether you need a licence or a licensed partner before enabling withdrawals at scale. Keep `PAYPAL_ENV=sandbox` until then.
- Imported listings link to their sources and use their flyer images by URL. Ask the bigger sources (RA, tickets.rs) about partnership or API terms before scaling the import.
- Map tiles default to CARTO basemaps, free up to 75k map views/month; above that use a paid CARTO/MapTiler/Stadia plan via `TILE_URL`.

## Project layout

```
src/
  server.js        boot, security headers, static files
  realtime.js      Socket.IO: chat, typing, presence, calls, notifications
  auth.js lib.js   sessions, validation, rate limits, idempotency, time zones
  ledger.js        balance changes, transfers, fees, limits
  sources.js       Ticketmaster sync, OpenStreetMap geocoding
  seed.js          @noktura account, launch listings, city round-ups
  cities.js        city picker list (60 cities)
  content/listings.js  launch listings
  routes/          people, chat (+uploads), events (+tickets), feed, money, market (+earn), map
supabase/schema.sql
public/
  index.html css/noktura.css js/core.js js/app.js js/views/*.js
  terms.html privacy.html refunds.html guidelines.html organisers.html
```

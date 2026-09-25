# NOKTURA — deployable version

This is the **New version** UI running on a real backend. The markup and CSS match the design source exactly. Only the demo scripts behind it were replaced.

- **Server:** Node 18+ with Express and Socket.IO (`src/`). It serves the site and the API from one Render web service.
- **Database:** PostgreSQL on **Supabase** (`supabase/schema.sql`). A Render Postgres database also works.
- **Frontend:** `public/`. It's generated from `Downloads/Noktura web/New version` by `scripts/build_frontend.py`. The original files aren't modified.

## What works

| Area | What it does |
|---|---|
| Accounts | Sign up, log in and log out. Passwords are hashed with bcrypt and logins use 30-day tokens. **Edit Profile** changes your city and avatar. |
| **World map** | Real OpenStreetMap tiles you can pan and zoom anywhere in the world. City and address search uses Nominatim. |
| **Droppable pins** | Tap **＋ Event pin**, **＋ Meet-up** or **＋ My location**, then tap the map and fill in the form. Pins are saved in the database. You can drag your own pins to move them and remove them from the drawer. Who can see a pin: All friends, Close friends, or public (used by the seeded events). Other people's maps update live. |
| Live location | **Locate me** shares your GPS position with your friends while the page is open. It stops when you tap **Stop sharing** or close the tab. |
| Messages | Real-time direct and group chats, typing indicators, online status, unread badges and file attachments (up to 8 MB). |
| Calls | Audio calls over WebRTC. You can turn on video during a call. The server only relays the connection setup. |
| Feed | Posts (including anonymous ones), likes, comments and shares, with live updates. |
| Friends | Search for people, follow and unfollow, and get notifications. |
| Tickets | Organisers post events. Buyers pay through PayPal Checkout and get ticket codes. Free events skip payment. |
| Door scanner | Scan a ticket with the camera, a QR image or the code. Check-ins are recorded on the server, so a ticket can't be used twice. |
| Wallet (NKT) | Balance and history, sending NKT to friends, PayPal top-ups and PayPal withdrawals. Every balance change is recorded in the database. |
| Marketplace | Listing items and buying them with NKT. The money moves from buyer to seller in one database transaction. |
| Earn | Ads that people fund with NKT, a reward for each view, a step counter using the phone's motion sensor, step milestones and a daily leaderboard. |

---

## Part 1 — Deploy on Render

### 1. Put this folder on GitHub

1. Create a new repository on https://github.com/new, e.g. `noktura`. It can be private.
2. Upload the **contents** of this folder. On the empty repo page, click **uploading an existing file**, drag in everything in this folder (`package.json`, `render.yaml`, `src/`, `public/`, `supabase/`, `scripts/`, `README.md`, `.gitignore`, `.env.example`), then click **Commit changes**.

### 2. Create the web service

1. Go to https://dashboard.render.com and click **New → Blueprint**.
2. Connect your GitHub account and pick the `noktura` repository. Render reads `render.yaml` automatically.
3. Render asks for the variables marked as secret:
   - `DATABASE_URL`: your Supabase connection string (see **Part 2**, step 2).
   - `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`: optional, so leave them empty for now.
   - `TICKETMASTER_API_KEY`: optional, so leave it empty.
   `JWT_SECRET` is generated for you.
4. Click **Apply**. The first deploy takes about 2–3 minutes. When the server starts, it creates all the tables and seeds the demo network.
5. Open the URL Render gives you, e.g. `https://noktura.onrender.com`, and create an account.

To set it up by hand instead of using the Blueprint, choose **New → Web Service** with runtime **Node**, build command `npm install --omit=dev`, start command `npm start` and health check path `/api/health`. Add the same environment variables.

> **Free plan:** Render puts the service to sleep after 15 minutes without traffic. The first visit after that takes about 30–50 seconds. Paid plans stay awake.

---

## Part 2 — Set up Supabase (the database)

### 1. Create the project

1. Go to https://supabase.com/dashboard and click **New project**.
2. Pick a name and a **strong database password**, and save the password. Choose the region closest to your Render region (Frankfurt ↔ `eu-central-1`, Oregon ↔ `us-west-1`, and so on).

### 2. Get the connection string

1. In the project, click **Connect** in the top bar and copy the **Session pooler** URI. It looks like this:
   ```
   postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
   ```
2. Replace `[YOUR-PASSWORD]` with your database password.
3. Paste the result into Render as `DATABASE_URL`: **Service → Environment → Save, rebuild and deploy**.

Use the **Session pooler** and not the "Direct connection". Render's network is IPv4, and Supabase's direct host is IPv6-only unless you buy the IPv4 add-on.

### 3. Create the tables (optional)

The server creates the tables on every start. To see them in Supabase first, open **SQL Editor → New query**, paste all of `supabase/schema.sql` and click **Run**. Running it again does no harm.

### 4. Security note

Row Level Security is **enabled with no policies** on every table. The Node server connects as the database owner, so it isn't affected. Supabase's public `anon` and `authenticated` API keys can't read or change anything, which keeps password hashes and balances private. Never paste the `service_role` key into the frontend.

### Using Render Postgres instead of Supabase

Create **New → PostgreSQL** on Render, copy its **Internal Database URL**, and use it as `DATABASE_URL`. Nothing else changes.

---

## Optional features

| Variable | What it enables |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` | Wallet top-ups, withdrawals and paid ticket checkout. Create a REST app at https://developer.paypal.com → **Apps & Credentials**. Test with `PAYPAL_ENV=sandbox` and sandbox buyer accounts, then switch to `live` with your live credentials. Withdrawals also need **Payouts** turned on for your PayPal business account. Without these variables, the payment screens show "PayPal isn't configured" and nothing is charged. |
| `TICKETMASTER_API_KEY`, `EXTERNAL_EVENT_CITIES` | Fills **Tickets → External** with real concerts in those cities. It refreshes daily. Get a free key at https://developer.ticketmaster.com. |
| `TILE_URL`, `TILE_ATTRIBUTION` | Map tiles. The default is the public OpenStreetMap server, which is fine for low traffic. For real traffic, switch to a tile provider such as MapTiler, Stadia or Thunderforest and paste its `{z}/{x}/{y}` URL. |
| `SEED_DEMO_DATA` | `true` by default. On first boot it creates the demo accounts @mia, @alex, @snake and @marko, which the sign-up flow adds as friends. It also creates the "Warehouse Night" event (used by the map's **View event** button), some example pins in Belgrade, Berlin and London, and the "Noktura general" chat. Demo accounts can't log in or receive NKT. Set it to `false` before the first deploy to start empty. |
| `PUBLIC_URL` | Your custom domain, if you add one. PayPal return links use it. |

## Updating the design later

When you change the UI in `Downloads/Noktura web/New version` (and re-run `build_new.py` there), rebuild the deployable frontend:

```bash
python scripts/build_frontend.py
```

Then upload the changed `public/index.html` (and `public/assets/`) to GitHub. Render redeploys automatically.

If the script prints a warning that the inline preview script changed, update `public/app-live.js` with those changes. It's the live version of `premium.js`.

## Running locally

You need Node 18+ and a Postgres URL (Supabase works fine).

```bash
cp .env.example .env
npm install
npm start
```

Open http://localhost:4000. The step counter needs HTTPS on a phone, which works on Render.

## Project layout

```
src/server.js        API routes and realtime (chat, calls, live pins)
src/db.js            Postgres pool, transactions, auto-migration
src/auth.js          sign-up / login / tokens
src/paypal.js        PayPal Orders + Payouts
src/seed.js          one-time demo network
supabase/schema.sql  full database schema (tables, indexes, RLS)
public/              the site: index.html (built), app-live.js, assets/
scripts/build_frontend.py  rebuilds public/ from the design source
render.yaml          Render Blueprint
```

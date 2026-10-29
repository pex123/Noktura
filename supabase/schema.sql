-- NOKTURA database schema (PostgreSQL 14+; Supabase or Render Postgres).
--
-- The server applies this file on every boot under an advisory lock, so it
-- is written to be idempotent: CREATE ... IF NOT EXISTS for new objects and
-- ADD COLUMN IF NOT EXISTS for columns added after the first release.
--
-- Timestamps are epoch milliseconds (BIGINT). Money is NUMERIC(14,2).
--
-- Row Level Security is enabled on every table with NO policies. The Node
-- server connects as the owner (bypasses RLS); Supabase's anon/authenticated
-- REST keys get no access, so balances and password hashes stay private.

-- ───────────────────────── accounts ─────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  handle        TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar        TEXT NOT NULL DEFAULT 'N',
  city          TEXT NOT NULL DEFAULT '',
  balance       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  is_demo       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_lower ON users (lower(handle));
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name  TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio           TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS city_lat      DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city_lng      DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_upload TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role          TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at  BIGINT;

CREATE TABLE IF NOT EXISTS login_failures (
  key        TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_key ON login_failures (key, created_at);

CREATE TABLE IF NOT EXISTS friends (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS friends_friend ON friends (friend_id);

CREATE TABLE IF NOT EXISTS close_friends (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('user','post','comment','message','event','listing','pin')),
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_status ON reports (status, created_at DESC);

-- ───────────────────────── chat ─────────────────────────
CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('dm','group','event')),
  name       TEXT,
  slug       TEXT UNIQUE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_members_user ON chat_members (user_id);
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  from_user  TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, created_at);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id    TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind       TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta       JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at BIGINT;

CREATE TABLE IF NOT EXISTS uploads (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id      TEXT REFERENCES chats(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  data         BYTEA NOT NULL,
  created_at   BIGINT NOT NULL
);
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'chat';

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, created_at DESC);

-- ───────────────────────── feed ─────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anon        BOOLEAN NOT NULL DEFAULT FALSE,
  text        TEXT NOT NULL,
  share_count INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_created ON posts (created_at DESC);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS city           TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_upload   TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_url      TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS link_url       TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS link_title     TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS event_id       TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS kind           TEXT NOT NULL DEFAULT 'post';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS headline       TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS promoted_until BIGINT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS like_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS comment_count  INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS posts_city_created ON posts (lower(city), created_at DESC);
CREATE INDEX IF NOT EXISTS posts_user ON posts (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS post_likes_user ON post_likes (user_id);

CREATE TABLE IF NOT EXISTS post_comments (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS post_comments_post ON post_comments (post_id, created_at);

-- ───────────────────────── events ─────────────────────────
-- One table for every event shown in the app: ones organisers create on
-- NOKTURA (source = 'noktura', sold through event_tiers) and listings
-- imported from the web (source = 'ra' | 'ticketmaster' | 'web'), which
-- link out to the original ticket page.
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  venue       TEXT NOT NULL DEFAULT '',
  date_text   TEXT NOT NULL DEFAULT '',
  price_usd   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (price_usd >= 0),
  currency    TEXT NOT NULL DEFAULT 'USD',
  capacity    INTEGER NOT NULL DEFAULT 200 CHECK (capacity > 0),
  sold        INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  created_at  BIGINT NOT NULL
);
ALTER TABLE events ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS source         TEXT NOT NULL DEFAULT 'noktura';
ALTER TABLE events ADD COLUMN IF NOT EXISTS external_url   TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS source_name    TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS city           TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS country        TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS address        TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS lat            DOUBLE PRECISION;
ALTER TABLE events ADD COLUMN IF NOT EXISTS lng            DOUBLE PRECISION;
ALTER TABLE events ADD COLUMN IF NOT EXISTS geo_precise    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS starts_at      BIGINT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS ends_at        BIGINT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS timezone       TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE events ADD COLUMN IF NOT EXISTS category       TEXT NOT NULL DEFAULT 'club';
ALTER TABLE events ADD COLUMN IF NOT EXISTS genres         TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS lineup         TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS image_url      TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS image_upload   TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS price_text     TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS min_age        INTEGER;
ALTER TABLE events ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'published';
ALTER TABLE events ADD COLUMN IF NOT EXISTS visibility     TEXT NOT NULL DEFAULT 'public';
ALTER TABLE events ADD COLUMN IF NOT EXISTS external_going INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN IF NOT EXISTS promoted_until BIGINT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at     BIGINT;
CREATE INDEX IF NOT EXISTS events_starts ON events (starts_at) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS events_geo ON events (lat, lng) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS events_city ON events (lower(city), starts_at);
CREATE INDEX IF NOT EXISTS events_user ON events (user_id);

CREATE TABLE IF NOT EXISTS event_tiers (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  price      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  capacity   INTEGER NOT NULL CHECK (capacity > 0),
  sold       INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  sort       INTEGER NOT NULL DEFAULT 0,
  sales_end  BIGINT,
  created_at BIGINT NOT NULL,
  CHECK (sold <= capacity)
);
CREATE INDEX IF NOT EXISTS event_tiers_event ON event_tiers (event_id, sort);

CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('going','interested')),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS event_rsvps_user ON event_rsvps (user_id);

-- Legacy table from the first release; its rows are folded into events on boot.
CREATE TABLE IF NOT EXISTS external_events (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  title      TEXT NOT NULL,
  venue      TEXT NOT NULL DEFAULT '',
  city       TEXT NOT NULL DEFAULT '',
  date_text  TEXT NOT NULL DEFAULT '',
  price_text TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL,
  image_url  TEXT NOT NULL DEFAULT '',
  starts_at  BIGINT,
  fetched_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS geocache (
  query      TEXT PRIMARY KEY,
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  label      TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_syncs (
  key        TEXT PRIMARY KEY,
  synced_at  BIGINT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ok'
);

-- ───────────────────────── map ─────────────────────────
CREATE TABLE IF NOT EXISTS pins (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('event','meetup','friend')),
  title       TEXT NOT NULL DEFAULT '',
  subtitle    TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  lat         DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  price_usd   NUMERIC(14,2),
  visibility  TEXT NOT NULL DEFAULT 'all_friends' CHECK (visibility IN ('public','all_friends','close_friends')),
  event_id    TEXT REFERENCES events(id) ON DELETE SET NULL,
  is_live_location BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS pins_user ON pins (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS pins_one_live_location ON pins (user_id) WHERE is_live_location;
ALTER TABLE pins ADD COLUMN IF NOT EXISTS starts_at      BIGINT;
ALTER TABLE pins ADD COLUMN IF NOT EXISTS expires_at     BIGINT;
ALTER TABLE pins ADD COLUMN IF NOT EXISTS promoted_until BIGINT;
CREATE INDEX IF NOT EXISTS pins_geo ON pins (lat, lng);

-- ───────────────────────── money ─────────────────────────
CREATE TABLE IF NOT EXISTS payment_orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  amount      NUMERIC(14,2) NOT NULL,
  items       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  BIGINT NOT NULL,
  captured_at BIGINT
);
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_kind_check;
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_provider_check;
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_status_check;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS expires_at BIGINT;
CREATE INDEX IF NOT EXISTS payment_orders_pending ON payment_orders (status, expires_at);

CREATE TABLE IF NOT EXISTS tickets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id    TEXT REFERENCES events(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  tier_name   TEXT NOT NULL DEFAULT 'Ticket',
  code        TEXT NOT NULL UNIQUE,
  price_paid  NUMERIC(14,2) NOT NULL DEFAULT 0,
  order_id    TEXT REFERENCES payment_orders(id) ON DELETE SET NULL,
  redeemed_at BIGINT,
  redeemed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_user ON tickets (user_id);
CREATE INDEX IF NOT EXISTS tickets_event ON tickets (event_id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tier_id TEXT REFERENCES event_tiers(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transferred_from TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS fee_paid NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS refunded_at BIGINT;

CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  from_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  to_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  from_label   TEXT NOT NULL,
  to_label     TEXT NOT NULL,
  amount       NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  type         TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  external_ref TEXT,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS transactions_from ON transactions (from_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_to ON transactions (to_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_requests (
  id           TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount       NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  note         TEXT NOT NULL DEFAULT '',
  group_id     TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','declined','cancelled')),
  created_at   BIGINT NOT NULL,
  settled_at   BIGINT
);
CREATE INDEX IF NOT EXISTS payment_requests_to ON payment_requests (to_user_id, status);
CREATE INDEX IF NOT EXISTS payment_requests_from ON payment_requests (from_user_id, status);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  response   JSONB,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS promotions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','pin','event','listing')),
  target_id   TEXT NOT NULL,
  days        INTEGER NOT NULL CHECK (days > 0),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  starts_at   BIGINT NOT NULL,
  ends_at     BIGINT NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS promotions_target ON promotions (target_type, target_id);

-- ───────────────────────── marketplace ─────────────────────────
CREATE TABLE IF NOT EXISTS market_items (
  id          TEXT PRIMARY KEY,
  seller_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL DEFAULT 'other',
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_axc   NUMERIC(14,2) NOT NULL CHECK (price_axc > 0),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','removed')),
  buyer_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  BIGINT NOT NULL,
  sold_at     BIGINT
);
ALTER TABLE market_items ADD COLUMN IF NOT EXISTS city           TEXT NOT NULL DEFAULT '';
ALTER TABLE market_items ADD COLUMN IF NOT EXISTS image_upload   TEXT;
ALTER TABLE market_items ADD COLUMN IF NOT EXISTS condition      TEXT NOT NULL DEFAULT '';
ALTER TABLE market_items ADD COLUMN IF NOT EXISTS promoted_until BIGINT;
CREATE INDEX IF NOT EXISTS market_items_active ON market_items (status, created_at DESC);

-- ───────────────────────── earn ─────────────────────────
CREATE TABLE IF NOT EXISTS ads (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  link            TEXT NOT NULL DEFAULT '',
  budget          NUMERIC(14,2) NOT NULL CHECK (budget > 0),
  spent           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (spent >= 0),
  reward_per_view NUMERIC(14,2) NOT NULL CHECK (reward_per_view > 0),
  created_at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS ad_views (
  ad_id      TEXT NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (ad_id, user_id)
);

CREATE TABLE IF NOT EXISTS steps (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,
  steps   INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0),
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS steps_day ON steps (day, steps DESC);

CREATE TABLE IF NOT EXISTS step_claims (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  milestone  INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, day, milestone)
);

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','login_failures','friends','close_friends','blocks','reports','chats','chat_members',
    'messages','uploads','notifications','posts','post_likes','post_comments','events','event_tiers','event_rsvps',
    'external_events','geocache','source_syncs','pins','payment_orders','tickets','transactions','payment_requests',
    'idempotency_keys','promotions','market_items','ads','ad_views','steps','step_claims','app_meta']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

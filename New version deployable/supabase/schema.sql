-- NOKTURA database schema (PostgreSQL 14+; Supabase or Render Postgres).
--
-- The server runs this automatically on every boot (it is idempotent), so
-- you don't *have* to paste it anywhere. Running it once in the Supabase
-- SQL editor first is still recommended so you can see the tables.
--
-- Timestamps are epoch milliseconds (BIGINT) because that's what the web
-- app works with. Money is NUMERIC(14,2) — never floating point.
--
-- Row Level Security is enabled on every table with NO policies. The
-- Node server connects as the database owner (bypasses RLS), while
-- Supabase's public anon/authenticated REST keys get no access at all,
-- so nobody can read password hashes or balances through the Supabase API.

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

CREATE TABLE IF NOT EXISTS friends (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS close_friends (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

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

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  from_user  TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, created_at);

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

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anon        BOOLEAN NOT NULL DEFAULT FALSE,
  text        TEXT NOT NULL,
  share_count INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_created ON posts (created_at DESC);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS post_comments_post ON post_comments (post_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS payment_orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('topup','cart')),
  provider    TEXT NOT NULL CHECK (provider IN ('paypal','free')),
  amount      NUMERIC(14,2) NOT NULL,
  items       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','captured','failed')),
  created_at  BIGINT NOT NULL,
  captured_at BIGINT
);

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
  FOREACH t IN ARRAY ARRAY['users','friends','close_friends','chats','chat_members','messages','uploads',
    'notifications','posts','post_likes','post_comments','events','external_events','pins','payment_orders',
    'tickets','transactions','market_items','ads','ad_views','steps','step_claims','app_meta']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

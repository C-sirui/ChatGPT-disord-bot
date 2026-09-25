-- Portable schema: runs unchanged on SQLite (dev/test) and Postgres (prod).
-- Money: integer micro-USD. Time: ISO-8601 UTC text. Ids: app-generated text.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',      -- user | admin
  status        TEXT NOT NULL DEFAULT 'active',    -- active | suspended
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'active',     -- active | revoked
  last_used_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX api_keys_user_idx ON api_keys(user_id);

-- Cached balances. The ledger is the source of truth; /admin/reconcile verifies.
CREATE TABLE wallets (
  user_id          TEXT PRIMARY KEY REFERENCES users(id),
  available_micros BIGINT NOT NULL DEFAULT 0,      -- buyer spendable (may go slightly negative on overage)
  held_micros      BIGINT NOT NULL DEFAULT 0,      -- reserved by in-flight requests
  earned_micros    BIGINT NOT NULL DEFAULT 0,      -- seller earnings not yet paid out
  updated_at       TEXT NOT NULL
);

CREATE TABLE ledger_txns (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                       -- topup | usage | payout | adjustment
  ref         TEXT,                                -- request id / payment id / payout id
  memo        TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX ledger_txns_kind_ref_idx ON ledger_txns(kind, ref);

CREATE TABLE ledger_entries (
  id           TEXT PRIMARY KEY,
  txn_id       TEXT NOT NULL REFERENCES ledger_txns(id),
  account      TEXT NOT NULL,                      -- user:<id>:available | user:<id>:earnings | platform:revenue | platform:clearing
  amount_micros BIGINT NOT NULL,                   -- +credit / -debit; each txn sums to 0
  created_at   TEXT NOT NULL
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries(account, created_at);
CREATE INDEX ledger_entries_txn_idx ON ledger_entries(txn_id);

CREATE TABLE holds (
  request_id   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  amount_micros BIGINT NOT NULL,
  status       TEXT NOT NULL,                      -- open | settled | released
  created_at   TEXT NOT NULL,
  closed_at    TEXT
);
CREATE INDEX holds_open_idx ON holds(status, created_at);

CREATE TABLE credentials (
  id                 TEXT PRIMARY KEY,
  seller_id          TEXT NOT NULL REFERENCES users(id),
  provider           TEXT NOT NULL,
  label              TEXT NOT NULL,
  base_url           TEXT,
  secret_ciphertext  TEXT NOT NULL,
  secret_mask        TEXT NOT NULL,
  fingerprint        TEXT NOT NULL UNIQUE,
  models             TEXT NOT NULL,                -- JSON array of catalog model ids
  hourly_token_limit BIGINT NOT NULL,
  max_concurrency    BIGINT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active', -- active | paused | invalid | disabled
  status_reason      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX credentials_provider_idx ON credentials(provider, status);
CREATE INDEX credentials_seller_idx ON credentials(seller_id);

-- Hour-bucketed capacity; atomic conditional UPDATEs keep limits exact across replicas.
CREATE TABLE credential_windows (
  credential_id   TEXT NOT NULL REFERENCES credentials(id),
  window_start    TEXT NOT NULL,
  used_tokens     BIGINT NOT NULL DEFAULT 0,
  reserved_tokens BIGINT NOT NULL DEFAULT 0,
  in_flight       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (credential_id, window_start)
);

-- One row per live capacity reservation, so a crashed node's reservations can be reaped.
CREATE TABLE capacity_reservations (
  request_id    TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  window_start  TEXT NOT NULL,
  tokens        BIGINT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (request_id, credential_id)
);
CREATE INDEX capacity_reservations_created_idx ON capacity_reservations(created_at);

CREATE TABLE requests (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  api_key_id    TEXT NOT NULL,
  model         TEXT NOT NULL,
  credential_id TEXT,
  stream        BIGINT NOT NULL,
  status        TEXT NOT NULL,                     -- pending | ok | error | client_aborted
  http_status   BIGINT,
  attempts      BIGINT NOT NULL DEFAULT 0,
  error_code    TEXT,
  latency_ms    BIGINT,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX requests_user_idx ON requests(user_id, created_at);

CREATE TABLE usage_events (
  request_id        TEXT PRIMARY KEY REFERENCES requests(id),
  buyer_id          TEXT NOT NULL,
  seller_id         TEXT NOT NULL,
  credential_id     TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_tokens     BIGINT NOT NULL,
  completion_tokens BIGINT NOT NULL,
  estimated         BIGINT NOT NULL,               -- 1 when upstream reported no usage
  buyer_cost_micros BIGINT NOT NULL,
  seller_credit_micros BIGINT NOT NULL,
  platform_fee_micros  BIGINT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX usage_buyer_idx ON usage_events(buyer_id, created_at);
CREATE INDEX usage_seller_idx ON usage_events(seller_id, created_at);

CREATE TABLE payments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  provider      TEXT NOT NULL,
  external_id   TEXT UNIQUE,
  amount_micros BIGINT NOT NULL,
  status        TEXT NOT NULL,                     -- pending | succeeded | failed
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX payments_user_idx ON payments(user_id);

CREATE TABLE payouts (
  id            TEXT PRIMARY KEY,
  seller_id     TEXT NOT NULL REFERENCES users(id),
  amount_micros BIGINT NOT NULL,
  status        TEXT NOT NULL,                     -- requested | paid | rejected
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX payouts_seller_idx ON payouts(seller_id);

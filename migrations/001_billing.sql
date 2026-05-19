CREATE TABLE IF NOT EXISTS billing_customers (
  public_key_fingerprint TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_subscription_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'incomplete',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_sessions (
  id BIGSERIAL PRIMARY KEY,
  public_key_fingerprint TEXT NOT NULL REFERENCES billing_customers(public_key_fingerprint) ON DELETE CASCADE,
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_events (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  public_key_fingerprint TEXT NOT NULL REFERENCES billing_customers(public_key_fingerprint) ON DELETE RESTRICT,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  stripe_subscription_item_id TEXT,
  plaid_item_id TEXT,
  data_kind TEXT NOT NULL,
  environment TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  estimated_cents INTEGER NOT NULL DEFAULT 0,
  stripe_status TEXT NOT NULL DEFAULT 'pending',
  stripe_error TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_events_public_key_requested_at_idx
  ON usage_events(public_key_fingerprint, requested_at DESC);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

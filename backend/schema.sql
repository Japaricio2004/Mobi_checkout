CREATE TABLE IF NOT EXISTS store_orders (
  id TEXT PRIMARY KEY,
  public_code TEXT NOT NULL UNIQUE,
  items JSONB NOT NULL,
  customer JSONB NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL,
  shipping NUMERIC(12,2) NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'pending_payment',
  payment_method TEXT,
  provider_order_id TEXT UNIQUE,
  provider_payment_id TEXT,
  provider_status TEXT,
  provider_status_detail TEXT,
  payment_attempt_key TEXT,
  payment_attempt_fingerprint TEXT,
  payment_attempt_reference TEXT,
  payment_attempt_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS store_orders_created_at_idx ON store_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS store_orders_provider_order_id_idx ON store_orders(provider_order_id);
ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS payment_attempt_key TEXT;
ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS payment_attempt_fingerprint TEXT;
ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS payment_attempt_reference TEXT;
ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS payment_attempt_started_at TIMESTAMPTZ;

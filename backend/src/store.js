import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { paymentAttemptAction } from './paymentAttempt.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const localFile = path.resolve(__dirname, '../data/orders.json');
const usePostgres = Boolean(process.env.DATABASE_URL);

let pool;
let localOrders = [];

export async function initializeStore() {
  if (usePostgres) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    await pool.query(`
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
    `);
    await pool.query('SELECT 1');
    console.log('Database: PostgreSQL conectado.');
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL es obligatorio en producción. Configura PostgreSQL antes de desplegar.');
  }

  try {
    const content = await fs.readFile(localFile, 'utf8');
    localOrders = JSON.parse(content);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    localOrders = [];
  }
  console.log('Database: almacenamiento JSON local (solo desarrollo).');
}

function normalize(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicCode: row.public_code ?? row.publicCode,
    items: row.items,
    customer: row.customer,
    subtotal: Number(row.subtotal),
    shipping: Number(row.shipping),
    total: Number(row.total),
    paymentStatus: row.payment_status ?? row.paymentStatus,
    paymentMethod: row.payment_method ?? row.paymentMethod ?? null,
    providerOrderId: row.provider_order_id ?? row.providerOrderId ?? null,
    providerPaymentId: row.provider_payment_id ?? row.providerPaymentId ?? null,
    providerStatus: row.provider_status ?? row.providerStatus ?? null,
    providerStatusDetail: row.provider_status_detail ?? row.providerStatusDetail ?? null,
    paymentAttemptKey: row.payment_attempt_key ?? row.paymentAttemptKey ?? null,
    paymentAttemptFingerprint: row.payment_attempt_fingerprint ?? row.paymentAttemptFingerprint ?? null,
    paymentAttemptReference: row.payment_attempt_reference ?? row.paymentAttemptReference ?? null,
    paymentAttemptStartedAt: row.payment_attempt_started_at ?? row.paymentAttemptStartedAt ?? null,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

async function persistLocal() {
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  const tempFile = `${localFile}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(localOrders, null, 2), 'utf8');
  await fs.rename(tempFile, localFile);
}

export async function createOrder(order) {
  if (pool) {
    const result = await pool.query(
      `INSERT INTO store_orders
       (id, public_code, items, customer, subtotal, shipping, total, payment_status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) RETURNING *`,
      [order.id, order.publicCode, JSON.stringify(order.items), JSON.stringify(order.customer), order.subtotal, order.shipping, order.total, order.paymentStatus],
    );
    return normalize(result.rows[0]);
  }
  const saved = { ...order, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  localOrders.unshift(saved);
  await persistLocal();
  return normalize(saved);
}

export async function getOrder(id) {
  if (pool) {
    const result = await pool.query('SELECT * FROM store_orders WHERE id = $1', [id]);
    return normalize(result.rows[0]);
  }
  return normalize(localOrders.find((order) => order.id === id));
}

export async function findOrderByProviderId(providerOrderId) {
  if (pool) {
    const result = await pool.query('SELECT * FROM store_orders WHERE provider_order_id = $1', [providerOrderId]);
    return normalize(result.rows[0]);
  }
  return normalize(localOrders.find((order) => order.providerOrderId === providerOrderId));
}

export async function findOrderByPublicCode(publicCode) {
  if (pool) {
    const result = await pool.query('SELECT * FROM store_orders WHERE public_code = $1', [publicCode]);
    return normalize(result.rows[0]);
  }
  return normalize(localOrders.find((order) => order.publicCode === publicCode));
}

function paymentConflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

export async function claimPaymentAttempt({ orderId, paymentMethod, fingerprint, createIdempotencyKey, createExternalReference }) {
  const idempotencyKey = createIdempotencyKey();
  if (pool) {
    const result = await pool.query(
      `UPDATE store_orders
       SET payment_status = 'processing', payment_method = $2,
           payment_attempt_key = $3, payment_attempt_fingerprint = $4,
           payment_attempt_reference = $5, payment_attempt_started_at = NOW(),
           provider_order_id = NULL, provider_payment_id = NULL,
           provider_status = NULL, provider_status_detail = NULL, updated_at = NOW()
       WHERE id = $1
         AND payment_status IN ('pending_payment', 'failed', 'cancelled')
         AND (provider_order_id IS NULL OR payment_status IN ('failed', 'cancelled'))
       RETURNING *`,
      [orderId, paymentMethod, idempotencyKey, fingerprint, createExternalReference(idempotencyKey)],
    );
    if (result.rows[0]) return { order: normalize(result.rows[0]), idempotencyKey, replay: false };
  } else {
    const index = localOrders.findIndex((order) => order.id === orderId);
    const current = normalize(localOrders[index]);
    if (!current) throw Object.assign(new Error('No encontramos el pedido.'), { status: 404 });
    if (paymentAttemptAction(current, fingerprint) === 'start') {
      const saved = {
        ...localOrders[index],
        paymentStatus: 'processing',
        paymentMethod,
        paymentAttemptKey: idempotencyKey,
        paymentAttemptFingerprint: fingerprint,
        paymentAttemptReference: createExternalReference(idempotencyKey),
        paymentAttemptStartedAt: new Date().toISOString(),
        providerOrderId: null,
        providerPaymentId: null,
        providerStatus: null,
        providerStatusDetail: null,
        updatedAt: new Date().toISOString(),
      };
      localOrders[index] = saved;
      await persistLocal();
      return { order: normalize(saved), idempotencyKey, replay: false };
    }
  }

  const current = await getOrder(orderId);
  const action = paymentAttemptAction(current, fingerprint);
  if (action === 'not_found') throw Object.assign(new Error('No encontramos el pedido.'), { status: 404 });
  if (action === 'already_paid') throw paymentConflict('Este pedido ya figura como pagado.');
  if (action === 'replay') {
    return { order: current, idempotencyKey: current.paymentAttemptKey, replay: true };
  }
  if (action === 'in_progress') {
    throw paymentConflict('Este pedido ya tiene un pago en curso. Consulta su estado antes de volver a intentar.');
  }
  throw paymentConflict('No se pudo iniciar otro intento para este pedido. Actualiza su estado e inténtalo nuevamente.');
}

export async function findOrderByPaymentAttemptReference(reference) {
  if (pool) {
    const result = await pool.query('SELECT * FROM store_orders WHERE payment_attempt_reference = $1', [reference]);
    return normalize(result.rows[0]);
  }
  return normalize(localOrders.find((order) => order.paymentAttemptReference === reference));
}

export async function resetPaymentAttempt(orderId, providerStatus = null, providerStatusDetail = null) {
  return updateOrder(orderId, {
    paymentStatus: 'failed',
    providerOrderId: null,
    providerPaymentId: null,
    providerStatus,
    providerStatusDetail,
    paymentAttemptKey: null,
    paymentAttemptFingerprint: null,
    paymentAttemptReference: null,
    paymentAttemptStartedAt: null,
  });
}

export async function updateOrder(id, patch) {
  const allowed = {
    paymentStatus: 'payment_status',
    paymentMethod: 'payment_method',
    providerOrderId: 'provider_order_id',
    providerPaymentId: 'provider_payment_id',
    providerStatus: 'provider_status',
    providerStatusDetail: 'provider_status_detail',
    paymentAttemptKey: 'payment_attempt_key',
    paymentAttemptFingerprint: 'payment_attempt_fingerprint',
    paymentAttemptReference: 'payment_attempt_reference',
    paymentAttemptStartedAt: 'payment_attempt_started_at',
  };
  if (pool) {
    const entries = Object.entries(patch).filter(([key]) => allowed[key]);
    if (!entries.length) return getOrder(id);
    const values = [id];
    const sets = entries.map(([key, value], index) => {
      values.push(value);
      return `${allowed[key]} = $${index + 2}`;
    });
    const result = await pool.query(
      `UPDATE store_orders SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      values,
    );
    return normalize(result.rows[0]);
  }
  const index = localOrders.findIndex((order) => order.id === id);
  if (index < 0) return null;
  localOrders[index] = { ...localOrders[index], ...patch, updatedAt: new Date().toISOString() };
  await persistLocal();
  return normalize(localOrders[index]);
}

export function databaseMode() {
  return pool ? 'postgresql' : 'local-json';
}

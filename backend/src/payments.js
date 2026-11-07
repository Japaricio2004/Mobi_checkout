import { createHmac, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import {
  getOrder, updateOrder, findOrderByProviderId, findOrderByPublicCode,
  claimPaymentAttempt, resetPaymentAttempt, findOrderByPaymentAttemptReference,
} from './store.js';
import { MIN_PAYMENT_AMOUNT, validatePaymentAmount } from './amount.js';

const MP_API = 'https://api.mercadopago.com';

export function getPaymentConfiguration() {
  const hasKeys = Boolean(process.env.MP_PUBLIC_KEY && process.env.MP_ACCESS_TOKEN);
  const productionRequested = process.env.MP_ENVIRONMENT === 'production';
  const liveAllowed = process.env.NODE_ENV === 'production'
    && productionRequested
    && process.env.ENABLE_LIVE_PAYMENTS === 'true'
    && process.env.STORE_LEGAL_SELLER_CONFIRMED === 'true'
    && Boolean(process.env.MP_WEBHOOK_SECRET)
    && Boolean(process.env.DATABASE_URL);
  const mode = productionRequested ? 'production' : 'test';
  return {
    publicKey: process.env.MP_PUBLIC_KEY || '',
    paymentsConfigured: hasKeys && (!productionRequested || liveAllowed),
    paymentMode: mode,
    minimumAmount: MIN_PAYMENT_AMOUNT,
    livePaymentsAllowed: liveAllowed,
    provider: 'mercadopago',
    unavailableReason: !hasKeys
      ? 'Faltan las credenciales de Mercado Pago.'
      : productionRequested && !liveAllowed
        ? 'Los cobros reales requieren comercio legítimo habilitado, PostgreSQL y firma secreta de Webhooks configurada.'
        : '',
  };
}

function assertPaymentsAvailable() {
  const config = getPaymentConfiguration();
  if (!config.paymentsConfigured) {
    const error = new Error(config.unavailableReason || 'Los pagos no están habilitados.');
    error.status = 503;
    throw error;
  }
}

async function createMercadoPagoOrder(payload, idempotencyKey) {
  assertPaymentsAvailable();
  const response = await fetch(`${MP_API}/v1/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerError = data.errors?.[0];
    const invalidAmount = data.errors?.some((entry) => entry.details?.some((detail) =>
      typeof detail === 'string' && detail.includes('invalid_transaction_amount')));
    const error = new Error(invalidAmount
      ? 'Mercado Pago rechazó el importe de esta operación. Vuelve a elegir un importe mayor antes de intentar pagar.'
      : data.message || data.cause?.[0]?.description || providerError?.message || providerError?.description || 'Mercado Pago no pudo procesar el pago.');
    error.status = response.status >= 400 && response.status < 500 ? 422 : 502;
    error.definitive = response.status >= 400 && response.status < 500;
    error.providerCode = invalidAmount ? 'invalid_transaction_amount' : data.error || providerError?.code || null;
    throw error;
  }
  return data;
}


function providerOrderStatus(data) {
  const status = String(data.status || '').toLowerCase();
  const detail = String(data.status_detail || '').toLowerCase();
  if (status === 'processed' && detail === 'accredited') return 'paid';
  if (status === 'failed') return 'failed';
  if (status === 'canceled' || status === 'cancelled') return 'cancelled';
  if (status === 'action_required') return 'action_required';
  return 'pending_payment';
}

function extractPaymentId(data) {
  return data.transactions?.payments?.[0]?.id || null;
}

function amountMatches(data, expectedAmount) {
  const actualAmount = Number(data.total_amount);
  const expected = Number(expectedAmount);
  const actualCurrency = data.currency || data.currency_id;
  return Number.isFinite(actualAmount)
    && Math.round(actualAmount * 100) === Math.round(expected * 100)
    && (!actualCurrency || actualCurrency === 'PEN');
}

function paymentStatusPatch(data, paymentMethod) {
  const paymentStatus = providerOrderStatus(data);
  const patch = {
    paymentStatus,
    paymentMethod,
    providerOrderId: data.id,
    providerPaymentId: extractPaymentId(data),
    providerStatus: data.status || null,
    providerStatusDetail: data.status_detail || null,
  };
  if (['failed', 'cancelled'].includes(paymentStatus)) {
    patch.paymentAttemptKey = null;
    patch.paymentAttemptFingerprint = null;
    patch.paymentAttemptReference = null;
    patch.paymentAttemptStartedAt = null;
  }
  return patch;
}

function stableFingerprint(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function submitPaymentOrder({ order, payload, paymentMethod, amount }) {
  const fingerprint = stableFingerprint(payload);
  const attempt = await claimPaymentAttempt({
    orderId: order.id,
    paymentMethod,
    fingerprint,
    createIdempotencyKey: randomUUID,
    createExternalReference: (key) => `${order.publicCode}-${key.replaceAll('-', '').slice(0, 16)}`,
  });
  payload.external_reference = attempt.order.paymentAttemptReference;

  let result;
  try {
    result = await createMercadoPagoOrder(payload, attempt.idempotencyKey);
  } catch (error) {
    // Only a definite 4xx response is safe to unlock for a new payment attempt.
    // Network failures and 5xx responses remain locked and can be replayed with
    // the same idempotency key or reconciled through provider search/webhooks.
    if (error.definitive) await resetPaymentAttempt(order.id, error.providerCode, null);
    throw error;
  }

  if (result.external_reference !== payload.external_reference || !amountMatches(result, amount)) {
    throw Object.assign(new Error('Mercado Pago devolvió una orden que no coincide con este importe. El pago quedó pendiente de verificación.'), { status: 502 });
  }
  const saved = await updateOrder(order.id, paymentStatusPatch(result, paymentMethod));
  return { order: saved, providerStatus: result.status, statusDetail: result.status_detail };
}

function buildPayer(order, overrides = {}) {
  const payer = {
    email: order.customer.email,
    entity_type: 'individual',
    phone: {
      area_code: '51',
      number: String(overrides.phone || order.customer.phone).replace(/\D/g, '').slice(-9),
    },
  };
  const dni = String(order.customer.dni || '').replace(/\D/g, '');
  if (dni.length === 8) payer.identification = { type: 'DNI', number: dni };
  return payer;
}

export async function payByCard({ orderId, token, paymentMethodId, paymentTypeId, installments, payer }) {
  if (!token || typeof token !== 'string') throw Object.assign(new Error('No se recibió el token seguro de la tarjeta.'), { status: 400 });
  if (!paymentMethodId || typeof paymentMethodId !== 'string') throw Object.assign(new Error('No se identificó la tarjeta.'), { status: 400 });
  const order = await getOrder(orderId);
  if (!order) throw Object.assign(new Error('No encontramos el pedido.'), { status: 404 });
  if (order.paymentStatus === 'paid') throw Object.assign(new Error('Este pedido ya figura como pagado.'), { status: 409 });

  const amount = validatePaymentAmount(order.total).toFixed(2);
  const paymentType = ['debit_card', 'credit_card', 'prepaid_card'].includes(paymentTypeId) ? paymentTypeId : 'credit_card';
  const payload = {
    type: 'online',
    processing_mode: 'automatic',
    total_amount: amount,
    payer: {
      ...buildPayer(order),
      ...(payer?.email ? { email: order.customer.email } : {}),
      ...(payer?.identification?.type && payer?.identification?.number
        ? { identification: { type: payer.identification.type, number: String(payer.identification.number) } }
        : {}),
    },
    transactions: {
      payments: [{
        amount,
        payment_method: {
          id: paymentMethodId,
          type: paymentType,
          token,
          installments: Math.min(12, Math.max(1, Number(installments) || 1)),
        },
      }],
    },
  };

  return submitPaymentOrder({ order, payload, paymentMethod: 'card', amount });
}

export async function payByYape({ orderId, token, phoneNumber }) {
  if (!token || typeof token !== 'string') throw Object.assign(new Error('No se pudo generar el token seguro de Yape.'), { status: 400 });
  const phone = String(phoneNumber || '').replace(/\D/g, '');
  const isTestMode = process.env.MP_ENVIRONMENT !== 'production';
  const testPhones = new Set(['111111111', '111111112', '111111113', '111111114', '111111115', '111111116', '111111117', '111111118']);
  const validPhone = isTestMode ? testPhones.has(phone) : /^9\d{8}$/.test(phone);
  if (!validPhone) throw Object.assign(new Error(isTestMode ? 'En Sandbox utiliza uno de los celulares de prueba de Mercado Pago.' : 'Ingresa un número de celular peruano válido.'), { status: 400 });
  const order = await getOrder(orderId);
  if (!order) throw Object.assign(new Error('No encontramos el pedido.'), { status: 404 });
  if (order.paymentStatus === 'paid') throw Object.assign(new Error('Este pedido ya figura como pagado.'), { status: 409 });
  if (Number(order.total) > 2000) throw Object.assign(new Error('El total supera el máximo documentado de S/ 2,000 por operación con Yape. Utiliza tarjeta.'), { status: 422 });

  const amount = validatePaymentAmount(order.total).toFixed(2);
  const payload = {
    type: 'online',
    processing_mode: 'automatic',
    total_amount: amount,
    payer: {
      ...buildPayer(order, { phone }),
      phone: { area_code: '51', number: phone },
    },
    transactions: {
      payments: [{
        amount,
        payment_method: { id: 'yape', type: 'debit_card', token },
      }],
    },
  };

  return submitPaymentOrder({ order, payload, paymentMethod: 'yape', amount });
}

async function fetchOrderByAttemptReference(order) {
  if (!order.paymentAttemptReference || !order.paymentAttemptStartedAt) return null;
  const begin = new Date(new Date(order.paymentAttemptStartedAt).getTime() - 5 * 60 * 1000).toISOString();
  const query = new URLSearchParams({
    begin_date: begin,
    end_date: new Date().toISOString(),
    external_reference: order.paymentAttemptReference,
    type: 'online',
    page: '1',
    page_size: '20',
  });
  const response = await fetch(`${MP_API}/v1/orders?${query}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
  });
  if (!response.ok) return null;
  const result = await response.json();
  return result.data?.find((entry) => entry.external_reference === order.paymentAttemptReference) || null;
}

export async function refreshOrderFromProvider(providerOrderId, fallbackOrder = null) {
  if (!process.env.MP_ACCESS_TOKEN) return null;
  let data;
  if (providerOrderId) {
    const response = await fetch(`${MP_API}/v1/orders/${encodeURIComponent(providerOrderId)}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });
    if (!response.ok) return null;
    data = await response.json();
  } else if (fallbackOrder?.paymentAttemptReference) {
    data = await fetchOrderByAttemptReference(fallbackOrder);
    if (!data) return null;
  } else {
    return null;
  }
  const order = await findOrderByProviderId(data.id)
    || await findOrderByPaymentAttemptReference(data.external_reference)
    || await findOrderByPublicCode(data.external_reference)
    || fallbackOrder;
  if (!order) return null;
  if (data.external_reference !== order.paymentAttemptReference && data.external_reference !== order.publicCode) return null;
  if (!amountMatches(data, Number(order.total).toFixed(2))) return null;
  return updateOrder(order.id, paymentStatusPatch(data, order.paymentMethod || null));
}

export function validateMercadoPagoSignature({ signature, requestId, dataId, secret }) {
  if (!signature || !requestId || !dataId || !secret) return false;
  const parts = Object.fromEntries(signature.split(',').map((part) => {
    const [key, ...value] = part.trim().split('=');
    return [key, value.join('=')];
  }));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');
  const received = Buffer.from(parts.v1, 'hex');
  const calculated = Buffer.from(expected, 'hex');
  return received.length === calculated.length && timingSafeEqual(received, calculated);
}

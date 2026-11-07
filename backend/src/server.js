import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { products, getProduct } from './catalog.js';
import { validatePaymentAmount } from './amount.js';
import { initializeStore, createOrder, getOrder, updateOrder, findOrderByProviderId, findOrderByPublicCode, findOrderByPaymentAttemptReference, databaseMode } from './store.js';
import { getPaymentConfiguration, payByCard, payByYape, refreshOrderFromProvider, validateMercadoPagoSignature } from './payments.js';

const app = express();
const port = Number(process.env.PORT || 4000);

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin(origin, callback) {
    const allowed = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map((value) => value.trim());
    if (!origin || allowed.includes(origin) || (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost:\d+$/.test(origin))) {
      callback(null, true);
      return;
    }
    const error = new Error('Origen no permitido por CORS.');
    error.status = 403;
    callback(error);
  },
}));
app.use(express.json({ limit: '40kb' }));

const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Demasiados intentos. Espera unos minutos antes de volver a intentar.' },
});

function cleanText(value, max = 180) {
  return String(value ?? '').trim().replace(/[<>]/g, '').slice(0, max);
}

function validateCustomer(input = {}) {
  const customer = {
    fullName: cleanText(input.fullName, 120),
    email: cleanText(input.email, 160).toLowerCase(),
    phone: String(input.phone ?? '').replace(/\D/g, '').slice(0, 15),
    dni: String(input.dni ?? '').replace(/\D/g, '').slice(0, 12),
    address: cleanText(input.address, 180),
    district: cleanText(input.district, 100),
    region: cleanText(input.region, 80),
  };
  if (customer.fullName.split(/\s+/).filter(Boolean).length < 2) throw Object.assign(new Error('Escribe tu nombre y apellido.'), { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw Object.assign(new Error('Ingresa un correo electrónico válido.'), { status: 400 });
  if (!/^9\d{8}$/.test(customer.phone)) throw Object.assign(new Error('Ingresa un celular peruano válido de 9 dígitos.'), { status: 400 });
  if (customer.dni && customer.dni.length !== 8) throw Object.assign(new Error('El DNI debe tener 8 dígitos.'), { status: 400 });
  if (customer.address.length < 6 || customer.district.length < 2 || customer.region.length < 2) {
    throw Object.assign(new Error('Completa tu dirección, distrito y región.'), { status: 400 });
  }
  return customer;
}

function mapItems(inputItems) {
  if (!Array.isArray(inputItems) || inputItems.length < 1 || inputItems.length > 6) {
    throw Object.assign(new Error('Selecciona entre 1 y 6 productos.'), { status: 400 });
  }
  const mapped = inputItems.map((entry) => {
    const product = getProduct(entry.productId);
    const quantity = Number(entry.quantity);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 3) {
      throw Object.assign(new Error('Hay un producto o cantidad no válida en el pedido.'), { status: 400 });
    }
    return {
      productId: product.id,
      name: product.name,
      brand: product.brand,
      image: product.image,
      unitPrice: 0,
      quantity,
      lineTotal: 0,
    };
  });
  return mapped;
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mobi-checkout-api', database: databaseMode(), timestamp: new Date().toISOString() });
});

app.get('/api/config', (_req, res) => {
  const config = getPaymentConfiguration();
  res.json({
    publicKey: config.publicKey,
    paymentsConfigured: config.paymentsConfigured,
    paymentMode: config.paymentMode,
    minimumAmount: config.minimumAmount,
    provider: config.provider,
    unavailableReason: config.unavailableReason,
  });
});

app.get('/api/products', (_req, res) => {
  const visibleProducts = products.map(({ price, oldPrice, ...product }) => ({ ...product, price: 0, oldPrice: 0 }));
  res.json({ products: visibleProducts });
});

app.post('/api/orders', async (req, res, next) => {
  try {
    const items = mapItems(req.body.items);
    const customer = validateCustomer(req.body.customer);
    // El comprador elige el importe de la operación; no es el precio del celular.
    const total = validatePaymentAmount(req.body.amount);
    const subtotal = total;
    const shipping = 0;
    const order = await createOrder({
      id: randomUUID(),
      publicCode: `MBI-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6).toUpperCase()}`,
      items,
      customer,
      subtotal,
      shipping,
      total,
      paymentStatus: 'pending_payment',
    });
    res.status(201).json({ order: publicOrder(order), config: getPaymentConfiguration() });
  } catch (error) {
    next(error);
  }
});

function publicOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    publicCode: order.publicCode,
    items: order.items,
    subtotal: order.subtotal,
    shipping: order.shipping,
    total: order.total,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    providerStatus: order.providerStatus,
    providerStatusDetail: order.providerStatusDetail,
    createdAt: order.createdAt,
  };
}

app.get('/api/orders/:id', async (req, res, next) => {
  try {
    let order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado.' });
    if (!['paid', 'failed', 'cancelled'].includes(order.paymentStatus)) {
      order = await refreshOrderFromProvider(order.providerOrderId, order) || order;
    }
    return res.json({ order: publicOrder(order) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/payments/card', paymentLimiter, async (req, res, next) => {
  try {
    const result = await payByCard({
      orderId: cleanText(req.body.orderId, 80),
      token: req.body.token,
      paymentMethodId: cleanText(req.body.paymentMethodId, 40),
      paymentTypeId: cleanText(req.body.paymentTypeId, 40),
      installments: req.body.installments,
      payer: req.body.payer,
      deviceId: cleanText(req.get('x-meli-session-id'), 256),
    });
    res.json({ order: publicOrder(result.order), providerStatus: result.providerStatus, statusDetail: result.statusDetail });
  } catch (error) {
    next(error);
  }
});

app.post('/api/payments/yape', paymentLimiter, async (req, res, next) => {
  try {
    const result = await payByYape({
      orderId: cleanText(req.body.orderId, 80),
      token: req.body.token,
      phoneNumber: req.body.phoneNumber,
      deviceId: cleanText(req.get('x-meli-session-id'), 256),
    });
    res.json({ order: publicOrder(result.order), providerStatus: result.providerStatus, statusDetail: result.statusDetail });
  } catch (error) {
    next(error);
  }
});

app.post('/api/webhooks/mercadopago', async (req, res, next) => {
  try {
    const dataId = String(req.query['data.id'] || req.body?.data?.id || '').trim();
    const type = String(req.query.type || req.body?.type || '').toLowerCase();
    if (type && type !== 'order') return res.sendStatus(200);
    const valid = validateMercadoPagoSignature({
      signature: req.headers['x-signature'],
      requestId: req.headers['x-request-id'],
      dataId,
      secret: process.env.MP_WEBHOOK_SECRET,
    });
    if (!valid) return res.status(401).json({ message: 'Firma de webhook no válida.' });

    const response = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(dataId)}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });
    if (!response.ok) return res.status(502).json({ message: 'No se pudo consultar la orden en Mercado Pago.' });
    const providerOrder = await response.json();
    const localOrder = await findOrderByProviderId(dataId)
      || await findOrderByPaymentAttemptReference(providerOrder.external_reference)
      || await findOrderByPublicCode(providerOrder.external_reference);
    if (localOrder) {
      const referenceMatches = providerOrder.external_reference === localOrder.paymentAttemptReference
        || providerOrder.external_reference === localOrder.publicCode
        || localOrder.providerOrderId === dataId;
      const amount = Number(providerOrder.total_amount);
      const currency = providerOrder.currency || providerOrder.currency_id;
      if (!referenceMatches
        || !Number.isFinite(amount)
        || Math.round(amount * 100) !== Math.round(Number(localOrder.total) * 100)
        || (currency && currency !== 'PEN')) {
        return res.status(502).json({ message: 'La orden notificada no coincide con el pedido registrado.' });
      }
      const status = String(providerOrder.status || '').toLowerCase();
      const detail = String(providerOrder.status_detail || '').toLowerCase();
      const paymentStatus = status === 'processed' && detail === 'accredited'
        ? 'paid'
        : status === 'failed' ? 'failed'
          : ['canceled', 'cancelled'].includes(status) ? 'cancelled'
            : status === 'action_required' ? 'action_required' : 'pending_payment';
      const paymentId = providerOrder.transactions?.payments?.[0]?.id || null;
      const patch = {
        paymentStatus,
        providerOrderId: providerOrder.id,
        providerPaymentId: paymentId,
        providerStatus: providerOrder.status || null,
        providerStatusDetail: providerOrder.status_detail || null,
      };
      if (['failed', 'cancelled'].includes(paymentStatus)) {
        patch.paymentAttemptKey = null;
        patch.paymentAttemptFingerprint = null;
        patch.paymentAttemptReference = null;
        patch.paymentAttemptStartedAt = null;
      }
      await updateOrder(localOrder.id, patch);
    }
    return res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error('[API]', error);
  res.status(status).json({
    message: status >= 500 ? 'Ocurrió un problema al procesar la solicitud. Inténtalo nuevamente.' : error.message,
    code: error.providerCode || undefined,
  });
});

await initializeStore();
app.listen(port, () => {
  console.log(`MOBI API escuchando en http://localhost:${port}`);
  console.log(`Mercado Pago: ${getPaymentConfiguration().paymentsConfigured ? 'credenciales configuradas' : 'pendiente de credenciales'}`);
});

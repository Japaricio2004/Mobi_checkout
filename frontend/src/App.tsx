import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { mountCardBrick } from './cardBrickLifecycle';
import {
  ArrowDownRight, ArrowLeft, ArrowRight, BadgeCheck, Check, CheckCircle2,
  ChevronDown, ChevronRight, CircleHelp, CreditCard, Headphones, LockKeyhole,
  MapPin, Menu, Minus, PackageCheck, Plus, ShieldCheck, ShoppingBag,
  Smartphone, Sparkles, Truck, Wallet, X, Zap,
} from 'lucide-react';

type Product = {
  id: string; brand: string; name: string; subtitle: string; price: number; oldPrice: number;
  badge: string; category: string; color: string; storage: string; description: string;
  image: string; imagePosition?: string; specs: string[];
};
type CartItem = { product: Product; quantity: number };
type Customer = { fullName: string; email: string; phone: string; dni: string; address: string; district: string; region: string };
type Order = {
  id: string; publicCode: string; items: Array<{ productId: string; name: string; quantity: number; unitPrice: number; lineTotal: number }>;
  subtotal: number; shipping: number; total: number; paymentStatus: string; paymentMethod?: string | null;
  providerStatus?: string | null; providerStatusDetail?: string | null;
};
type PaymentConfig = { publicKey: string; paymentsConfigured: boolean; paymentMode: 'test' | 'production'; minimumAmount: number; provider: string; unavailableReason?: string };

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const money = (value: number) => new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const emptyCustomer: Customer = { fullName: '', email: '', phone: '', dni: '', address: '', district: '', region: 'Lima' };
const categories = ['Todos', 'Apple', 'Samsung', 'Xiaomi'];

function mercadoPagoDeviceHeaders(): Record<string, string> {
  const deviceId = window.deviceId || window.MP_DEVICE_SESSION_ID;
  return deviceId ? { 'X-meli-session-id': deviceId } : {};
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || 'No se pudo completar la solicitud.'), { status: response.status });
  return data as T;
}

function CardPaymentBrick({
  publicKey, order, customer, onResult, onError,
}: {
  publicKey: string; order: Order; customer: Customer;
  onResult: (order: Order) => void; onError: (message: string) => void;
}) {
  const callbacks = useRef({ onResult, onError });
  callbacks.current = { onResult, onError };

  useEffect(() => {
    let cancelled = false;
    const mount = async () => {
      if (!window.MercadoPago) {
        throw new Error('No se pudo cargar el SDK de Mercado Pago.');
      }
        const mp = new window.MercadoPago(publicKey, { locale: 'es-PE' });
        const bricksBuilder = mp.bricks();
        const settings = {
          initialization: {
            amount: Number(order.total),
            payer: { email: customer.email },
          },
          callbacks: {
            onReady: () => { if (!cancelled) callbacks.current.onError(''); },
            onSubmit: async (formData: any, additionalData: any) => {
              try {
                const response = await api<{ order: Order }>('/api/payments/card', {
                  method: 'POST',
                  headers: mercadoPagoDeviceHeaders(),
                  body: JSON.stringify({
                    orderId: order.id,
                    token: formData.token,
                    paymentMethodId: formData.payment_method_id,
                    paymentTypeId: additionalData?.paymentTypeId,
                    installments: formData.installments,
                    payer: formData.payer,
                  }),
                });
                if (!cancelled) callbacks.current.onResult(response.order);
                return Promise.resolve();
              } catch (error) {
                const message = error instanceof Error ? error.message : 'No se pudo procesar la tarjeta.';
                const status = (error as Error & { status?: number }).status;
                if (status === 409 || status === undefined || status >= 500) {
                  try {
                    const latest = await api<{ order: Order }>(`/api/orders/${order.id}`);
                    if (latest.order.paymentStatus === 'processing' || latest.order.providerStatus) {
                      if (!cancelled) callbacks.current.onResult(latest.order);
                      return Promise.resolve();
                    }
                  } catch { /* La respuesta original explica el error si no se puede consultar el estado. */ }
                }
                if (!cancelled) callbacks.current.onError(message);
                return Promise.reject(error);
              }
            },
            onError: (error: unknown) => {
              console.error('Mercado Pago Card Brick:', error);
              if (!cancelled) callbacks.current.onError('No se pudo validar el formulario de tarjeta. Revisa los datos e inténtalo nuevamente.');
            },
          },
        };
        return bricksBuilder.create('cardPayment', 'card-payment-brick', settings);
    };

    const unmount = mountCardBrick(mount, (error) => {
      console.error('Mercado Pago: no se pudo iniciar el formulario.', error);
      callbacks.current.onError('No se pudo iniciar el formulario de Mercado Pago. Revisa la conexión y consulta el detalle en la consola.');
    });
    return () => {
      cancelled = true;
      unmount();
    };
  }, [publicKey, order.id, order.total, customer.email]);

  return (
    <div className="card-brick-shell">
      <div className="secure-form-heading"><span className="secure-icon"><LockKeyhole size={16} /></span><span>Formulario seguro de Mercado Pago</span></div>
      <div id="card-payment-brick" />
      <p className="microcopy"><ShieldCheck size={14} /> Los datos de tu tarjeta se tokenizan en Mercado Pago. MOBI no los almacena.</p>
    </div>
  );
}

function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [category, setCategory] = useState('Todos');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [customer, setCustomer] = useState<Customer>(emptyCustomer);
  const [order, setOrder] = useState<Order | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'yape'>('card');
  const [yapePhone, setYapePhone] = useState('');
  const [yapeOtp, setYapeOtp] = useState('');
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  const [orderBusy, setOrderBusy] = useState(false);
  const [amountInput, setAmountInput] = useState('');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [detailProduct, setDetailProduct] = useState<Product | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ products: Product[] }>('/api/products'),
      api<PaymentConfig>('/api/config'),
    ]).then(([productData, paymentConfig]) => {
      if (!active) return;
      setProducts(productData.products);
      setConfig(paymentConfig);
    }).catch((error) => {
      if (active) setLoadError(error instanceof Error ? error.message : 'No se pudo conectar con el servidor.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const filteredProducts = useMemo(() => products.filter((product) => {
    const matchesCategory = category === 'Todos' || product.category === category;
    const term = search.toLowerCase().trim();
    const matchesSearch = !term || `${product.name} ${product.brand} ${product.subtitle}`.toLowerCase().includes(term);
    return matchesCategory && matchesSearch;
  }), [products, category, search]);

  const isTestMode = config?.paymentMode !== 'production';
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const enteredAmount = amountInput.trim().replace(',', '.');
  const amount = Number(enteredAmount);
  const minimumAmount = config?.minimumAmount ?? 2;
  const validAmount = /^\d+(?:\.\d{1,2})?$/.test(enteredAmount) && amount >= minimumAmount && amount <= 9999999.99;

  const addToCart = (product: Product, quantity = 1) => {
    setCart((current) => {
      const found = current.find((item) => item.product.id === product.id);
      if (found) return current.map((item) => item.product.id === product.id ? { ...item, quantity: Math.min(3, item.quantity + quantity) } : item);
      return [...current, { product, quantity: Math.min(3, quantity) }];
    });
    setDetailProduct(null);
    setCartOpen(true);
  };

  const buyNow = (product: Product) => {
    setCart([{ product, quantity: 1 }]);
    setOrder(null);
    setCustomer(emptyCustomer);
    setAmountInput('');
    setPaymentError('');
    setStep(1);
    setDetailProduct(null);
    setCartOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const updateQuantity = (productId: string, delta: number) => {
    setCart((current) => current.map((item) => item.product.id === productId
      ? { ...item, quantity: Math.max(1, Math.min(3, item.quantity + delta)) }
      : item));
  };

  const removeItem = (productId: string) => setCart((current) => current.filter((item) => item.product.id !== productId));

  const beginCheckout = () => {
    if (cart.length) {
      setCartOpen(false);
      setStep(1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const createOrderAndContinue = async () => {
    if (orderBusy) return;
    if (!validAmount) {
      setPaymentError(`Mercado Pago admite pagos desde ${money(minimumAmount)}. Ingresa ese importe o uno mayor, con un máximo de dos decimales.`);
      return;
    }
    setOrderBusy(true);
    setPaymentError('');
    try {
      const response = await api<{ order: Order; config: PaymentConfig }>('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          items: cart.map((item) => ({ productId: item.product.id, quantity: item.quantity })),
          customer,
          amount: enteredAmount,
        }),
      });
      setOrder(response.order);
      setConfig(response.config);
      setStep(4);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      setPaymentError(error instanceof Error ? error.message : 'Revisa los datos e inténtalo nuevamente.');
    } finally {
      setOrderBusy(false);
    }
  };

  const updateCustomer = (field: keyof Customer, value: string) => setCustomer((current) => ({ ...current, [field]: value }));

  const validateCustomer = () => {
    if (customer.fullName.trim().split(/\s+/).filter(Boolean).length < 2) return 'Escribe tu nombre y apellido.';
    if (!/^\S+@\S+\.\S+$/.test(customer.email)) return 'Ingresa un correo electrónico válido.';
    if (!/^9\d{8}$/.test(customer.phone.replace(/\D/g, ''))) return 'Ingresa un celular peruano válido de 9 dígitos.';
    if (customer.dni && !/^\d{8}$/.test(customer.dni)) return 'El DNI debe tener 8 dígitos.';
    if (customer.address.trim().length < 6 || customer.district.trim().length < 2 || !customer.region) return 'Completa tu dirección, distrito y región.';
    return '';
  };

  const completePayment = (updatedOrder: Order) => {
    setOrder(updatedOrder);
    setPaymentError('');
    setStep(5);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submitYape = async (event: FormEvent) => {
    event.preventDefault();
    if (!order || !config?.publicKey) return;
    setPaymentError('');
    setPaymentBusy(true);
    try {
      if (!window.MercadoPago) throw new Error('No se pudo cargar Mercado Pago. Recarga la página.');
      const phone = yapePhone.replace(/\D/g, '');
      const testPhones = ['111111111', '111111112', '111111113', '111111114', '111111115', '111111116', '111111117', '111111118'];
      if (config.paymentMode === 'test' ? !testPhones.includes(phone) : !/^9\d{8}$/.test(phone)) {
        throw new Error(config.paymentMode === 'test' ? 'En Sandbox utiliza uno de los celulares de prueba indicados en pantalla.' : 'Ingresa tu número de celular Yape de 9 dígitos.');
      }
      if (!/^\d{6}$/.test(yapeOtp)) throw new Error('Ingresa el código OTP de 6 dígitos que genera Yape.');
      const mp = new window.MercadoPago(config.publicKey, { locale: 'es-PE' });
      const yape = mp.yape({ otp: yapeOtp, phoneNumber: phone });
      const tokenResponse = await yape.create();
      const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.id;
      if (!token) throw new Error('Yape no devolvió un token válido. Genera un nuevo código e inténtalo otra vez.');
      const response = await api<{ order: Order }>('/api/payments/yape', {
        method: 'POST',
        headers: mercadoPagoDeviceHeaders(),
        body: JSON.stringify({ orderId: order.id, token, phoneNumber: phone }),
      });
      setYapeOtp('');
      completePayment(response.order);
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status === 409 || status === undefined || status >= 500) {
        try {
          const latest = await api<{ order: Order }>(`/api/orders/${order.id}`);
          if (latest.order.paymentStatus === 'processing' || latest.order.providerStatus) {
            setYapeOtp('');
            completePayment(latest.order);
            return;
          }
        } catch { /* Se conserva el error de pago si el estado tampoco está disponible. */ }
      }
      setPaymentError(error instanceof Error ? error.message : 'No se pudo procesar el pago con Yape.');
    } finally {
      setPaymentBusy(false);
    }
  };

  const refreshOrder = async () => {
    if (!order) return;
    try {
      const response = await api<{ order: Order }>(`/api/orders/${order.id}`);
      setOrder(response.order);
    } catch (error) {
      setPaymentError(error instanceof Error ? error.message : 'No se pudo consultar el pedido.');
    }
  };

  const restart = () => {
    setCart([]); setOrder(null); setCustomer(emptyCustomer); setStep(0); setPaymentError(''); setYapeOtp(''); setYapePhone(''); setAmountInput('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const showCatalog = step === 0;
  const yapeOverDocumentedLimit = Boolean(order && order.total > 2000);

  return (
    <div className="app-shell">
      <div className="announcement"><span className="announcement-dot" /> Una experiencia de compra simple, transparente y segura <span className="announcement-separator">·</span> Catálogo de demostración</div>
      <header className="site-header">
        <div className="header-inner">
          <button className="brand" onClick={restart} aria-label="Volver al inicio"><span className="brand-mark"><Smartphone size={19} strokeWidth={2.5} /></span><span>MOBI<span className="brand-period">.</span></span></button>
          <nav className={`main-nav ${mobileMenu ? 'nav-open' : ''}`}>
            <button onClick={() => { setStep(0); setMobileMenu(false); }}>Celulares</button>
            <button onClick={() => { setCategory('Apple'); setStep(0); setMobileMenu(false); }}>Apple</button>
            <button onClick={() => { setCategory('Samsung'); setStep(0); setMobileMenu(false); }}>Samsung</button>
            <button onClick={() => { setCategory('Xiaomi'); setStep(0); setMobileMenu(false); }}>Xiaomi</button>
          </nav>
          <div className="header-actions">
            <button className="secure-note"><ShieldCheck size={15} /> Compra protegida</button>
            <button className="cart-button" onClick={() => setCartOpen(true)} aria-label="Abrir carrito"><ShoppingBag size={19} /><span>Bolsa</span><b>{cartCount}</b></button>
            <button className="mobile-menu-button" onClick={() => setMobileMenu((value) => !value)} aria-label="Abrir menú"><Menu size={21} /></button>
          </div>
        </div>
      </header>

      {showCatalog ? (
        <>
          <main>
            <section className="hero-section">
              <div className="hero-copy">
                <div className="eyebrow"><span className="eyebrow-line" /> TECNOLOGÍA PARA TU DÍA A DÍA</div>
                <h1>Tu próximo<br /><span>smartphone</span><br />está aquí.</h1>
                <p>Descubre dispositivos que combinan diseño, potencia y una experiencia que se siente desde el primer uso.</p>
                <div className="hero-actions"><button className="button button-lime" onClick={() => document.getElementById('catalogo')?.scrollIntoView({ behavior: 'smooth' })}>Explorar celulares <ArrowRight size={17} /></button><span className="hero-caption"><ShieldCheck size={15} /> Checkout seguro</span></div>
                <div className="hero-stats"><div><strong>01</strong><span>Elige tu equipo</span></div><i /><div><strong>02</strong><span>Completa tus datos</span></div><i /><div><strong>03</strong><span>Realiza tu pago</span></div></div>
              </div>
              <div className="hero-art">
                <div className="hero-glow" />
                <div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" />
                <div className="hero-phone-shadow" />
                <img src="https://images.unsplash.com/photo-1592750475338-74b7b21085ab?auto=format&fit=crop&w=1100&q=90" alt="Smartphone de última generación" />
                <div className="hero-floating-card"><span className="floating-icon"><Zap size={16} /></span><div><b>Rendimiento</b><small>Sin límites</small></div><span className="floating-arrow"><ArrowDownRight size={16} /></span></div>
                <div className="hero-chip">NEW <span>2026</span></div>
              </div>
              <div className="hero-bottom-label"><span>01 / 03</span><span>DESCUBRE · ELIGE · DISFRUTA</span></div>
            </section>

            <section className="trust-strip">
              <div><span className="trust-icon"><Truck size={19} /></span><div><b>Entrega coordinada</b><small>Información clara antes de comprar</small></div></div>
              <div><span className="trust-icon"><ShieldCheck size={19} /></span><div><b>Pago protegido</b><small>Procesamiento mediante pasarela</small></div></div>
              <div><span className="trust-icon"><Headphones size={19} /></span><div><b>Atención cercana</b><small>Una experiencia sin complicaciones</small></div></div>
            </section>

            <section className="catalog-section" id="catalogo">
              <div className="section-heading">
                <div><div className="eyebrow dark-eyebrow"><span className="eyebrow-line" /> SELECCIÓN MOBI</div><h2>Encuentra tu <span>próximo favorito.</span></h2><p>Equipos seleccionados para diferentes estilos y formas de usar la tecnología.</p></div>
                <div className="catalog-count"><strong>{filteredProducts.length.toString().padStart(2, '0')}</strong><span>PRODUCTOS</span></div>
              </div>
              <div className="catalog-toolbar">
                <div className="category-tabs">{categories.map((item) => <button key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div>
                <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar celular..." /></label>
              </div>
              {loadError && <div className="inline-alert error-alert">{loadError} Comprueba que el backend esté iniciado.</div>}
              {loading ? <div className="loading-grid">{[1, 2, 3].map((n) => <div className="skeleton-card" key={n} />)}</div> : (
                <div className="product-grid">
                  {filteredProducts.map((product, index) => <article className="product-card" key={product.id}>
                    <button className="product-image-wrap" onClick={() => setDetailProduct(product)} aria-label={`Ver ${product.name}`}>
                      <span className={`product-badge ${index === 0 ? 'badge-dark' : ''}`}>{product.badge}</span>
                      <img src={product.image} alt={product.name} style={{ objectPosition: product.imagePosition || 'center' }} loading="lazy" />
                      <span className="image-view"><ArrowDownRight size={16} /></span>
                    </button>
                    <div className="product-info">
                      <div className="product-meta"><span>{product.brand}</span><span>{product.storage}</span></div>
                      <button className="product-name" onClick={() => setDetailProduct(product)}>{product.name}</button>
                      <p>{product.subtitle}</p>
                      <div className="product-bottom"><div><strong className="price-hidden">Precio no publicado</strong></div><button className="add-button" onClick={() => addToCart(product)} aria-label={`Añadir ${product.name} al carrito`}><Plus size={19} /></button></div>
                      <button className="buy-link" onClick={() => buyNow(product)}>Comprar ahora <ArrowRight size={14} /></button>
                    </div>
                  </article>)}
                </div>
              )}
              {!loading && filteredProducts.length === 0 && <div className="empty-state"><Smartphone size={28} /><b>No encontramos resultados</b><span>Prueba otra búsqueda o categoría.</span></div>}
            </section>

            <section className="checkout-promo">
              <div className="promo-mark"><LockKeyhole size={23} /></div><div><span>UNA COMPRA, PASO A PASO</span><h3>Tu compra, sin vueltas.</h3><p>Un proceso claro para elegir, completar tus datos y pagar con confianza.</p></div><button onClick={() => document.getElementById('catalogo')?.scrollIntoView({ behavior: 'smooth' })}>Ver celulares <ArrowRight size={17} /></button>
            </section>
          </main>
          <footer className="site-footer"><div className="footer-top"><div className="brand footer-brand"><span className="brand-mark"><Smartphone size={18} /></span><span>MOBI<span className="brand-period">.</span></span></div><p>Tecnología que se adapta a tu mundo.</p><div className="footer-links"><span>Experiencia de compra</span><span>Pagos seguros</span><span>Atención</span></div></div><div className="footer-bottom"><span>© 2026 MOBI. Interfaz de demostración.</span><span>Catálogo de referencia · Importe elegido por el comprador · Sin despacho de productos.</span></div></footer>
        </>
      ) : (
        <main className="checkout-main">
          <div className="checkout-topline"><button className="back-to-store" onClick={() => { setStep(0); setOrder(null); }}><ArrowLeft size={16} /> Volver a la tienda</button><span className="checkout-security"><LockKeyhole size={14} /> Conexión protegida</span></div>
          <div className="checkout-header"><div className="eyebrow dark-eyebrow"><span className="eyebrow-line" /> {isTestMode ? 'DEMOSTRACIÓN DE PAGOS' : 'FINALIZA TU COMPRA'}</div><h1>{step === 5 ? 'Estado de tu pedido.' : 'Unos pasos y listo.'}</h1><p>{step === 5 ? 'Consulta el resultado que devolvió la pasarela de pago.' : isTestMode ? 'Selecciona un equipo y recorre el checkout. Elige cuánto deseas pagar antes de seleccionar tarjeta o Yape.' : 'Te acompañamos en cada etapa para que todo sea sencillo.'}</p></div>
          <div className="stepper">
            {['Tu pedido', 'Tus datos', 'Importe', 'Método de pago', 'Confirmación'].map((label, index) => <div className={`stepper-item ${step >= index + 1 ? 'current' : ''} ${step > index + 1 ? 'completed' : ''}`} key={label}><span className="step-number">{step > index + 1 ? <Check size={15} /> : index + 1}</span><span>{label}</span></div>)}
          </div>

          {step === 1 && <div className="checkout-layout">
            <section className="checkout-panel"><div className="panel-title"><div><span className="panel-kicker">PASO 01</span><h2>Revisa tu pedido</h2><p>Confirma los equipos que elegiste antes de continuar.</p></div><span className="panel-icon"><ShoppingBag size={20} /></span></div>
              <div className="order-items">{cart.map((item) => <div className="order-item" key={item.product.id}><div className="order-item-image"><img src={item.product.image} alt={item.product.name} /></div><div className="order-item-info"><span>{item.product.brand}</span><b>{item.product.name}</b><small>{item.product.subtitle}</small><div className="quantity-control"><button onClick={() => updateQuantity(item.product.id, -1)} disabled={item.quantity <= 1}><Minus size={13} /></button><b>{item.quantity}</b><button onClick={() => updateQuantity(item.product.id, 1)} disabled={item.quantity >= 3}><Plus size={13} /></button></div></div><div className="order-item-price"><button onClick={() => removeItem(item.product.id)}>Quitar</button></div></div>)}</div>
              <button className="text-action" onClick={() => setStep(0)}><Plus size={15} /> Seguir explorando celulares</button>
            </section>
            <aside className="summary-panel"><span className="summary-kicker">RESUMEN</span><h3>Tu selección</h3><p>{cartCount} equipo(s) seleccionado(s).</p><p className="summary-safe">Elegirás el importe después de completar tus datos. No se ha realizado ningún pago.</p><button className="button button-dark full-button" disabled={!cart.length} onClick={() => setStep(2)}>Continuar <ArrowRight size={17} /></button></aside>
          </div>}

          {step === 2 && <div className="checkout-layout">
            <section className="checkout-panel"><div className="panel-title"><div><span className="panel-kicker">PASO 02</span><h2>Completa tus datos</h2><p>Completa tus datos para identificar la operación.</p></div><span className="panel-icon"><MapPin size={20} /></span></div>
              <form className="customer-form" onSubmit={(event) => { event.preventDefault(); const error = validateCustomer(); if (error) setPaymentError(error); else { setPaymentError(''); setStep(3); } }}>
                <div className="form-section-label">DATOS PERSONALES</div>
                <div className="form-grid"><label className="form-field span-2"><span>Nombre y apellidos</span><input value={customer.fullName} onChange={(e) => updateCustomer('fullName', e.target.value)} placeholder="Ej. Andrea García" autoComplete="name" required /></label><label className="form-field"><span>Correo electrónico</span><input type="email" value={customer.email} onChange={(e) => updateCustomer('email', e.target.value)} placeholder="tucorreo@email.com" autoComplete="email" required /></label><label className="form-field"><span>Celular</span><input type="tel" inputMode="numeric" maxLength={9} value={customer.phone} onChange={(e) => updateCustomer('phone', e.target.value.replace(/\D/g, '').slice(0, 9))} placeholder="987 654 321" autoComplete="tel" required /></label><label className="form-field"><span>DNI <small>(opcional)</small></span><input inputMode="numeric" maxLength={8} value={customer.dni} onChange={(e) => updateCustomer('dni', e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="00000000" /></label></div>
                <div className="form-section-label form-section-spaced">DIRECCIÓN DE REFERENCIA</div>
                <div className="form-grid"><label className="form-field span-2"><span>Dirección</span><input value={customer.address} onChange={(e) => updateCustomer('address', e.target.value)} placeholder="Av. / Jr. / Calle y número" autoComplete="street-address" required /></label><label className="form-field"><span>Distrito</span><input value={customer.district} onChange={(e) => updateCustomer('district', e.target.value)} placeholder="Miraflores" required /></label><label className="form-field"><span>Región</span><select value={customer.region} onChange={(e) => updateCustomer('region', e.target.value)}><option>Lima</option><option>Callao</option><option>Ica</option><option>Arequipa</option><option>La Libertad</option><option>Piura</option><option>Cusco</option><option>Junín</option><option>Lambayeque</option><option>Otra región</option></select></label></div>
                {paymentError && <div className="inline-alert error-alert">{paymentError}</div>}
                <div className="form-actions"><button type="button" className="button button-ghost" onClick={() => { setPaymentError(''); setStep(1); }}><ArrowLeft size={16} /> Atrás</button><button type="submit" className="button button-dark" disabled={orderBusy}>Elegir importe <ArrowRight size={17} /></button></div>
              </form>
            </section>
            <aside className="summary-panel"><span className="summary-kicker">TU SELECCIÓN</span><h3>Resumen</h3>{cart.map((item) => <div className="mini-summary-item" key={item.product.id}><img src={item.product.image} alt="" /><div><b>{item.product.name}</b><small>Cantidad: {item.quantity} · Precio no publicado</small></div></div>)}<div className="summary-divider" /><p>Importe por elegir en el siguiente paso.</p><p className="summary-safe"><LockKeyhole size={14} /> Aún no se ha realizado ningún pago.</p></aside>
          </div>}

          {step === 3 && <section className="checkout-panel amount-panel">
            <span className="panel-kicker">PASO 03</span>
            <h2>Elige cuánto deseas pagar</h2>
            <form onSubmit={(event) => { event.preventDefault(); createOrderAndContinue(); }}>
              <label className="form-field" htmlFor="payment-amount"><span>Introduce el importe que deseas pagar</span></label>
              <div className="amount-input-wrap"><span>S/</span><input id="payment-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amountInput} onChange={(event) => { setAmountInput(event.target.value); setPaymentError(''); }} aria-describedby="amount-help" required /></div>
              <p id="amount-help">El comprador introduce libremente el importe. No representa el precio del celular.</p>
              <div className="amount-presets" aria-label="Importes sugeridos">{['2.00', '3.00', '5.00', '10.00'].map((value) => <button key={value} type="button" aria-pressed={enteredAmount === value} onClick={() => { setAmountInput(value); setPaymentError(''); }}>S/ {value}</button>)}</div>
              <p className="summary-safe">{isTestMode ? 'Modo de prueba. La operación no corresponde a la compra ni al despacho de un celular.' : 'Se cobrará únicamente el importe elegido cuando confirmes el pago. No incluye la compra ni el despacho del celular de referencia.'}</p>
              <p className="microcopy">Mercado Pago admite tarjeta y Yape desde {money(minimumAmount)}. No se modificará automáticamente el importe que ingreses.</p>
              {paymentError && <div className="inline-alert error-alert" role="alert">{paymentError}</div>}
              <div className="form-actions"><button type="button" className="button button-ghost" disabled={orderBusy} onClick={() => { setPaymentError(''); setStep(2); }}><ArrowLeft size={16} /> Atrás</button><button type="submit" className="button button-dark" disabled={orderBusy}>{orderBusy ? 'Guardando importe...' : 'Seleccionar tarjeta o Yape'} <ArrowRight size={17} /></button></div>
            </form>
          </section>}

          {step === 4 && order && <div className="checkout-layout payment-layout">
            <section className="checkout-panel"><div className="panel-title"><div><span className="panel-kicker">{isTestMode ? 'PASO 04 · SANDBOX' : 'PASO 04'}</span><h2>{isTestMode ? 'Prueba el método de pago' : 'Elige cómo pagar'}</h2><p>{isTestMode ? 'Esta operación utiliza credenciales de prueba: no se cobrará dinero real.' : 'Selecciona tu método y sigue las indicaciones.'}</p></div><span className="panel-icon"><Wallet size={20} /></span></div>
              {!config?.paymentsConfigured && <div className="inline-alert warning-alert"><CircleHelp size={17} /><span><b>Falta configurar Mercado Pago.</b> {config?.unavailableReason || 'Añade tus credenciales en el archivo .env para habilitar el formulario real.'}</span></div>}
              <div className="payment-method-tabs"><button className={paymentMethod === 'card' ? 'selected' : ''} onClick={() => { setPaymentMethod('card'); setPaymentError(''); }}><CreditCard size={20} /><span><b>Tarjeta</b><small>Crédito o débito</small></span><i /></button><button className={paymentMethod === 'yape' ? 'selected' : ''} disabled={yapeOverDocumentedLimit} onClick={() => { setPaymentMethod('yape'); setPaymentError(''); }}><span className="yape-symbol">Y</span><span><b>Yape</b><small>{yapeOverDocumentedLimit ? 'Supera S/ 2,000' : 'Paga desde tu app'}</small></span><i /></button></div>
              {paymentMethod === 'card' ? (
                config?.paymentsConfigured && config.publicKey ? <CardPaymentBrick key={`${order.id}-${paymentMethod}`} publicKey={config.publicKey} order={order} customer={customer} onResult={completePayment} onError={setPaymentError} /> : <div className="payment-placeholder"><div className="placeholder-icon"><CreditCard size={24} /></div><b>Formulario de tarjeta</b><p>Cuando configures la clave pública y el Access Token de Mercado Pago, aquí aparecerá el formulario seguro para ingresar la tarjeta.</p><div className="card-brands"><span>VISA</span><span>mastercard</span><span>AMEX</span></div></div>
              ) : (
                <form className="yape-form" onSubmit={submitYape}>
                  <div className="yape-intro"><span className="yape-big">Y</span><div><b>{isTestMode ? 'Prueba de Yape' : 'Paga con Yape'}</b><p>{isTestMode ? 'Utiliza los datos de prueba de Mercado Pago que aparecen abajo; no abras tu aplicación Yape real.' : 'Abre Yape, genera tu código de aprobación (OTP) y completa los datos.'}</p></div></div>
                  <label className="form-field"><span>Número de celular asociado a Yape</span><div className="phone-input"><span>+51</span><input inputMode="numeric" maxLength={9} value={yapePhone} onChange={(e) => setYapePhone(e.target.value.replace(/\D/g, '').slice(0, 9))} placeholder={isTestMode ? '111 111 111' : '987 654 321'} required /></div></label>
                  <label className="form-field"><span>Código OTP de Yape <small>(6 dígitos)</small></span><input inputMode="numeric" maxLength={6} value={yapeOtp} onChange={(e) => setYapeOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="••••••" required /></label>
                  <p className="yape-help">{isTestMode ? 'Datos de prueba: celular 111111111 y OTP 123456 para un resultado aprobado. Para probar rechazos, consulta la guía de pruebas de Mercado Pago. No ingreses tu número ni tu clave personal de Yape.' : 'El OTP es el código temporal que genera la aplicación Yape para autorizar un pago. No ingreses tu clave personal de Yape. El límite por operación depende de tu cuenta (puede ser S/ 500, S/ 900 o S/ 2,000); si tu límite es menor al total, utiliza tarjeta.'}</p>
                  <button type="submit" className="button button-dark full-button" disabled={paymentBusy || !config?.paymentsConfigured}>{paymentBusy ? 'Procesando con Mercado Pago...' : isTestMode ? 'Probar Yape' : `Pagar ${money(order.total)} con Yape`} <ArrowRight size={17} /></button>
                </form>
              )}
              {paymentError && <div className="inline-alert error-alert">{paymentError}</div>}
              <div className="payment-footnote"><ShieldCheck size={15} /><span>El estado se confirma desde el servidor y se contrasta con Mercado Pago. Nunca mostramos una compra como pagada solo por volver a esta página.</span></div>
              <div className="form-actions payment-back"><button className="button button-ghost" onClick={() => { setPaymentError(''); setStep(3); }}><ArrowLeft size={16} /> Cambiar importe</button></div>
            </section>
            <aside className="summary-panel sticky-summary"><span className="summary-kicker">OPERACIÓN {order.publicCode}</span><h3>Resumen de pago</h3>{order.items.map((item) => <div className="mini-summary-item" key={item.productId}><div className="mini-item-placeholder"><Smartphone size={18} /></div><div><b>{item.name}</b><small>Cantidad: {item.quantity} · Precio no publicado</small></div></div>)}<div className="summary-divider" /><div className="summary-total"><span>Importe elegido{isTestMode ? ' (prueba)' : ''}</span><strong>{money(order.total)}</strong></div><div className="summary-lock"><LockKeyhole size={15} /> Pendiente de pago</div><p className="summary-safe">Mercado Pago procesará la operación cuando confirmes el pago. Este importe no es el precio del celular.</p></aside>
          </div>}

          {step === 5 && order && <div className="result-wrap">
            <div className={`result-card ${order.paymentStatus === 'paid' ? 'result-paid' : order.paymentStatus === 'failed' ? 'result-failed' : ''}`}>
              <div className="result-symbol">{order.paymentStatus === 'paid' ? <CheckCircle2 size={36} /> : order.paymentStatus === 'failed' ? <X size={36} /> : <CircleHelp size={36} />}</div>
              <span className="result-kicker">PEDIDO {order.publicCode}</span>
              <h2>{order.paymentStatus === 'paid' ? (isTestMode ? 'Prueba aprobada.' : 'Pago confirmado.') : order.paymentStatus === 'failed' ? (isTestMode ? 'Prueba rechazada.' : 'El pago no fue aprobado.') : order.paymentStatus === 'cancelled' ? 'Pago cancelado.' : 'Estamos verificando el pago.'}</h2>
              <p>{order.paymentStatus === 'paid' ? (isTestMode ? 'Mercado Pago devolvió un resultado de prueba aprobado. No se realizó ningún cobro real.' : 'Mercado Pago confirmó la operación. El pedido quedó registrado como pagado.') : order.paymentStatus === 'failed' ? (isTestMode ? 'Mercado Pago devolvió un resultado de prueba rechazado. Puedes intentar otro escenario.' : 'La pasarela rechazó la operación. Puedes revisar los datos o elegir otro método.') : 'El estado todavía no es definitivo. Puedes consultar nuevamente; no repitas el pago hasta verificar el resultado.'}</p>
              <div className="result-details"><div><span>{isTestMode ? 'Importe elegido (prueba)' : 'Importe elegido'}</span><b>{money(order.total)}</b></div><div><span>Método</span><b>{order.paymentMethod === 'yape' ? 'Yape' : order.paymentMethod === 'card' ? 'Tarjeta' : 'Pendiente'}</b></div><div><span>Estado proveedor</span><b>{order.providerStatus || 'Sin respuesta'}</b></div></div>
              <div className="result-actions">{order.paymentStatus !== 'paid' && <button className="button button-ghost" onClick={refreshOrder}><Zap size={16} /> Consultar estado</button>}{['failed', 'cancelled'].includes(order.paymentStatus) && <button className="button button-dark" onClick={() => { setPaymentError(''); setStep(4); }}>Volver al pago <ArrowRight size={16} /></button>}<button className="button button-lime" onClick={restart}>Volver a la tienda</button></div>
            </div>
            <div className="result-note"><ShieldCheck size={17} /><span>Este resultado se obtiene de la respuesta de Mercado Pago y puede actualizarse mediante una notificación segura (webhook).</span></div>
          </div>}
          <div className="checkout-footer-note"><LockKeyhole size={14} /> Tus datos de tarjeta nunca pasan por nuestro servidor. <span>·</span> {isTestMode ? 'Sandbox: no se realiza ningún cobro real.' : 'Plataforma en producción.'}</div>
        </main>
      )}

      {cartOpen && <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setCartOpen(false); }}><aside className="cart-drawer"><div className="drawer-heading"><div><span className="panel-kicker">TU SELECCIÓN</span><h2>Tu bolsa <span>({cartCount})</span></h2></div><button className="icon-button" onClick={() => setCartOpen(false)} aria-label="Cerrar"><X size={21} /></button></div>
        {cart.length ? <><div className="drawer-items">{cart.map((item) => <div className="drawer-item" key={item.product.id}><img src={item.product.image} alt={item.product.name} /><div className="drawer-item-info"><span>{item.product.brand}</span><b>{item.product.name}</b><small>Precio no publicado</small><div className="quantity-control"><button onClick={() => updateQuantity(item.product.id, -1)} disabled={item.quantity <= 1}><Minus size={12} /></button><b>{item.quantity}</b><button onClick={() => updateQuantity(item.product.id, 1)} disabled={item.quantity >= 3}><Plus size={12} /></button></div></div><button className="remove-button" onClick={() => removeItem(item.product.id)} aria-label="Quitar producto"><X size={15} /></button></div>)}</div><div className="drawer-bottom"><p>Elegirás cuánto deseas pagar después de completar tus datos.</p><button className="button button-dark full-button" onClick={beginCheckout}>Continuar <ArrowRight size={17} /></button><p><ShieldCheck size={14} /> Aún no se ha realizado ningún pago.</p></div></> : <div className="drawer-empty"><ShoppingBag size={32} /><b>Tu bolsa está vacía</b><span>Agrega un celular para comenzar.</span><button className="button button-dark" onClick={() => setCartOpen(false)}>Explorar celulares</button></div>}
      </aside></div>}

      {detailProduct && <div className="overlay modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setDetailProduct(null); }}><div className="product-modal"><button className="icon-button modal-close" onClick={() => setDetailProduct(null)}><X size={20} /></button><div className="modal-product-image"><img src={detailProduct.image} alt={detailProduct.name} /></div><div className="modal-product-copy"><span className="panel-kicker">{detailProduct.brand} · {detailProduct.storage}</span><h2>{detailProduct.name}</h2><p>{detailProduct.description}</p><div className="modal-price"><strong className="price-hidden">Precio no publicado</strong></div><div className="spec-list">{detailProduct.specs.map((spec) => <span key={spec}><CheckCircle2 size={15} />{spec}</span>)}</div><div className="modal-actions"><button className="button button-ghost" onClick={() => addToCart(detailProduct)}>Añadir a la bolsa <Plus size={16} /></button><button className="button button-dark" onClick={() => buyNow(detailProduct)}>Comprar ahora <ArrowRight size={16} /></button></div><small className="modal-demo-note">Celular de referencia. El importe se elige durante el checkout y no representa el precio del equipo.</small></div></div></div>}
    </div>
  );
}

export default App;

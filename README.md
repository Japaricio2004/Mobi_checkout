# MOBI — plataforma de compra y checkout

Aplicación de comercio electrónico de demostración construida con React + TypeScript y Node.js + Express. Incluye catálogo precargado, bolsa de compra, checkout de cinco etapas, persistencia de pedidos y una integración de pago preparada para Mercado Pago Checkout API (Orders API), con tarjeta y Yape.

> **Importante:** el catálogo, los precios y los productos incluidos son referenciales. Esta versión no vende ni despacha productos reales. Por seguridad, no habilites cobros reales para una tienda ficticia ni cobres a terceros por productos que no vas a entregar. Para pagos reales se necesita una actividad comercial legítima, una cuenta de vendedor aprobada por Mercado Pago y productos/servicios que puedan cumplirse.

## 1. Requisitos

- Node.js 20 o superior.
- npm 10 o superior.
- Credenciales de prueba de Mercado Pago para probar la integración.

Los precios de los celulares permanecen ocultos en ambos entornos. El comprador selecciona un equipo, completa sus datos, introduce libremente un importe y elige tarjeta o Yape. No hay un importe fijo ni preseleccionado. El importe elegido no representa el precio del celular y no incluye su compra ni despacho. Aunque los medios de pago reportaron un mínimo de S/ 1.00, una operación de prueba por S/ 1.00 fue rechazada por Mercado Pago (`invalid_transaction_amount`); S/ 2.00 y S/ 3.00 sí fueron aprobados. Por eso, la app valida un mínimo conservador de S/ 2.00 y ofrece S/ 2, S/ 3, S/ 5 y S/ 10 como sugerencias. El importe no se cambia automáticamente. En modo `test`, utiliza exclusivamente credenciales y medios de pago de prueba.
- PostgreSQL para producción. En desarrollo, si no configuras `DATABASE_URL`, el backend guarda pedidos en un archivo JSON local.

## 2. Instalación local

Desde la carpeta raíz del proyecto:

```bash
npm install
```

Copia el archivo de variables de entorno:

```bash
cp .env.example .env
```

En Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Completa en `.env` las credenciales de prueba de tu aplicación de Mercado Pago:

```env
MP_PUBLIC_KEY=TU_PUBLIC_KEY_DE_PRUEBA
MP_ACCESS_TOKEN=TU_ACCESS_TOKEN_DE_PRUEBA
MP_WEBHOOK_SECRET=TU_FIRMA_SECRETA_DE_WEBHOOKS
MP_ENVIRONMENT=test
```

No compartas el `MP_ACCESS_TOKEN` ni el `MP_WEBHOOK_SECRET`. El backend los utiliza; nunca deben ponerse en el código React ni subirse a GitHub.

Inicia frontend y backend en una sola terminal:

```bash
npm run dev
```

Direcciones locales:

- Tienda: http://localhost:5173
- API: http://localhost:4000
- Estado de API: http://localhost:4000/api/health

El frontend usa el proxy de Vite para las rutas `/api` durante el desarrollo.

## 3. Flujo implementado

1. Catálogo de celulares precargados.
2. Selección de producto y bolsa de compra.
3. Datos de contacto y dirección.
4. Elección del importe por el comprador. El backend valida los equipos y el importe, registra el pedido pendiente y guarda ese total para enviarlo a Mercado Pago. No se cobra hasta confirmar el pago. Los resúmenes anteriores a este paso no muestran un total.
5. Pago con tarjeta mediante Card Payment Brick de Mercado Pago.
6. Pago de prueba con Yape mediante `MercadoPago.js`, generando un token de un solo uso con celular + OTP. En Sandbox usa el celular `111111111` y OTP `123456` para un resultado aprobado; el proyecto también admite los números de prueba documentados para escenarios de rechazo. No uses tu cuenta real de Yape.
7. Creación de una order en Mercado Pago desde el backend con una `X-Idempotency-Key` guardada por intento. El backend bloquea intentos concurrentes, reutiliza la misma clave si se repite exactamente la solicitud y conserva el pedido en verificación cuando la respuesta es ambigua. La consulta a Orders API y el webhook firmado permiten reconciliar esos casos antes de aceptar otro intento.
8. Pantalla de resultado según el estado devuelto por Mercado Pago.
9. Webhook firmado para sincronizar el estado de la order desde Mercado Pago.

No se almacenan números de tarjeta, CVV ni el OTP de Yape. El frontend tokeniza la información con el SDK de Mercado Pago y envía únicamente el token al backend.

## 4. Configurar Webhooks

En el panel de Mercado Pago, dentro de tu aplicación:

1. Abre **Webhooks / Configuración de notificaciones**.
2. Configura la URL pública de tu backend:
   `https://TU-DOMINIO-API/api/webhooks/mercadopago`
3. Selecciona el evento **Order (Mercado Pago)** para Checkout API con Orders.
4. Guarda y copia la firma secreta generada.
5. Añade esa firma a `MP_WEBHOOK_SECRET` en las variables del backend.

En local puedes usar un túnel HTTPS para recibir notificaciones de prueba. El endpoint valida `x-signature` y `x-request-id`, consulta la order directamente en Mercado Pago y luego actualiza el pedido local. No confía en el contenido del webhook como única fuente de verdad. Para la demostración, usa siempre credenciales de prueba; no introduzcas tarjetas reales ni claves de Yape reales.

## 5. Base de datos

En desarrollo, sin `DATABASE_URL`, se utiliza `backend/data/orders.json`.

En producción, `DATABASE_URL` es obligatorio y debe apuntar a PostgreSQL. El backend crea la tabla `store_orders` automáticamente al iniciar. Puedes utilizar PostgreSQL administrado (por ejemplo, Supabase, Neon o Render PostgreSQL).

Variables:

```env
DATABASE_URL=postgresql://USUARIO:CLAVE@HOST:5432/BASE
DATABASE_SSL=true
```

Configura `DATABASE_SSL=true` si el proveedor exige conexión TLS. Si tu proveedor entrega parámetros SSL específicos, adapta la configuración a sus instrucciones.

## 6. Preparación para despliegue

Una opción de despliegue separado:

- Frontend React: Vercel o Netlify.
- Backend Express: Render, Railway o un servidor Node.js.
- Base de datos: PostgreSQL administrado.

### Frontend

Configura en el servicio frontend:

```env
VITE_API_URL=https://TU-DOMINIO-API
```

Comando de build:

```bash
npm run build
```

Directorio publicado: `frontend/dist`.

### Backend

Configura en el servicio backend:

```env
NODE_ENV=production
PORT=4000
CLIENT_ORIGIN=https://TU-DOMINIO-FRONTEND
DATABASE_URL=postgresql://...
DATABASE_SSL=true
MP_PUBLIC_KEY=...
MP_ACCESS_TOKEN=...
MP_WEBHOOK_SECRET=...
MP_ENVIRONMENT=test
ENABLE_LIVE_PAYMENTS=false
STORE_LEGAL_SELLER_CONFIRMED=false
```

Comando de inicio:

```bash
npm start
```

Usa HTTPS en el frontend y en el backend. Mercado Pago requiere certificado SSL para operar en producción.

## 7. Activación de pagos reales

La integración está separada por entorno. El valor predeterminado es `MP_ENVIRONMENT=test`.

El backend bloquea pagos de producción salvo que se cumplan todas estas condiciones:

- `NODE_ENV=production`.
- `MP_ENVIRONMENT=production`.
- `ENABLE_LIVE_PAYMENTS=true`.
- `STORE_LEGAL_SELLER_CONFIRMED=true`.
- `DATABASE_URL` de PostgreSQL y `MP_WEBHOOK_SECRET` configurados.
- Credenciales productivas válidas.
- Cuenta de vendedor y aplicación habilitadas por Mercado Pago.
- Sitio web real, HTTPS, información comercial y capacidad de entregar los productos/servicios ofrecidos.

Las dos variables de confirmación son una barrera operativa del proyecto, no sustituyen la revisión ni la aprobación de Mercado Pago. No las actives para una tienda ficticia.

## 8. Comandos

```bash
npm run dev       # frontend + backend
npm run build     # compila el frontend
npm run check     # revisa sintaxis backend y compila frontend
npm start         # inicia backend (producción)
```

## 9. Estructura

```text
mobi-checkout/
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── styles.css
│   │   └── global.d.ts
│   ├── index.html
│   └── vite.config.ts
├── backend/
│   ├── src/
│   │   ├── catalog.js
│   │   ├── payments.js
│   │   ├── server.js
│   │   └── store.js
│   └── data/
├── .env.example
└── package.json
```

## 10. Alcance pendiente antes de producción comercial

- Reemplazar catálogo, imágenes y precios referenciales por productos reales.
- Definir despacho, devoluciones, garantía, privacidad, términos y canales de atención.
- Validar requisitos comerciales y de protección al consumidor aplicables en Perú.
- Configurar credenciales productivas y webhooks de producción una vez aprobado el comercio.
- Ejecutar pruebas de punta a punta en el entorno de prueba de Mercado Pago y pruebas de seguridad del despliegue.

La aplicación no incluye panel administrativo porque el alcance acordado es la experiencia de compra y el checkout.

## 11. Datos de prueba oficiales

- **Tarjeta Visa de prueba:** `4009 1753 3280 6176`, CVV `123`, vencimiento `11/30`. Para provocar una aprobación, el titular debe ser `APRO` y el documento `123456789` (según la guía de tarjetas de prueba de Mercado Pago).
- **Yape de prueba aprobado:** celular `111111111`, OTP `123456`.
- Para probar rechazos de Yape, consulta la tabla oficial de [compras de prueba con Yape](https://www.mercadopago.com.pe/developers/es/docs/checkout-api-orders/integration-test/yape).

Estos datos solo funcionan con credenciales de prueba y no mueven dinero real.

## Verificación del importe

`npm test --workspace backend` comprueba importes sugeridos, valores personalizados y rechazo de cero, negativos, importes ausentes o con más de dos decimales.

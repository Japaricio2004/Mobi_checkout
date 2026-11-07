// Although the payment methods report PEN 1 as their minimum, the live test
// integration rejected a S/ 1 order. S/ 2 is the lowest amount confirmed here.
export const MIN_PAYMENT_AMOUNT = 2;

export function validatePaymentAmount(value) {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw Object.assign(new Error('Ingresa un importe válido con un máximo de dos decimales.'), { status: 400 });
  }
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents < MIN_PAYMENT_AMOUNT * 100 || cents > 999999999) {
    throw Object.assign(new Error('En esta integración, el menor importe confirmado es S/ 2.00. Ingresa un importe entre S/ 2.00 y S/ 9,999,999.99.'), { status: 400 });
  }
  return cents / 100;
}

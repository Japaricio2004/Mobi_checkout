import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_PAYMENT_AMOUNT, validatePaymentAmount } from './amount.js';

test('accepts the amount selected by the buyer without a fixed sandbox override', () => {
  assert.equal(MIN_PAYMENT_AMOUNT, 2);
  for (const amount of ['2.00', '2.01', '3.00', '5.00', '10.00', '17.35', 2000, '9999999.99']) {
    assert.equal(validatePaymentAmount(amount), Number(amount));
  }
});

test('rejects missing, zero, negative, imprecise, malformed and out-of-range amounts', () => {
  for (const amount of [undefined, null, '', ' ', 0, '0.00', 0.01, '0.10', '0.20', '0.50', '0.99', '1.00', '1.01', '1.99', -1, '0.001', '1.999', '1e2', '0x10', '1,50', NaN, Infinity, true, [], {}, '10000000', '99999999999999999999']) {
    assert.throws(() => validatePaymentAmount(amount), { status: 400 });
  }
});

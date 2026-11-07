import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentAttemptAction } from './paymentAttempt.js';

const baseOrder = {
  paymentStatus: 'pending_payment',
  paymentAttemptFingerprint: null,
  providerOrderId: null,
};

test('allows a first attempt and a new attempt after a definitive failure', () => {
  assert.equal(paymentAttemptAction(baseOrder, 'fingerprint-1'), 'start');
  assert.equal(paymentAttemptAction({ ...baseOrder, paymentStatus: 'failed', providerOrderId: 'old-order' }, 'fingerprint-2'), 'start');
  assert.equal(paymentAttemptAction({ ...baseOrder, paymentStatus: 'cancelled', providerOrderId: 'old-order' }, 'fingerprint-2'), 'start');
});

test('reuses the same attempt only for an identical request', () => {
  const inProgress = {
    ...baseOrder,
    paymentStatus: 'processing',
    paymentAttemptFingerprint: 'fingerprint-1',
  };
  assert.equal(paymentAttemptAction(inProgress, 'fingerprint-1'), 'replay');
  assert.equal(paymentAttemptAction(inProgress, 'fingerprint-2'), 'in_progress');
});

test('blocks paid orders and orders with an unresolved provider order', () => {
  assert.equal(paymentAttemptAction({ ...baseOrder, paymentStatus: 'paid' }, 'fingerprint-1'), 'already_paid');
  assert.equal(paymentAttemptAction({ ...baseOrder, providerOrderId: 'provider-order' }, 'fingerprint-1'), 'in_progress');
  assert.equal(paymentAttemptAction(null, 'fingerprint-1'), 'not_found');
});

export function paymentAttemptAction(order, fingerprint) {
  if (!order) return 'not_found';
  if (order.paymentStatus === 'paid') return 'already_paid';
  if (order.paymentStatus === 'processing' && order.paymentAttemptFingerprint === fingerprint) return 'replay';
  if (['pending_payment', 'failed', 'cancelled'].includes(order.paymentStatus)
    && (!order.providerOrderId || ['failed', 'cancelled'].includes(order.paymentStatus))) return 'start';
  if (order.paymentStatus === 'processing' || order.providerOrderId) return 'in_progress';
  return 'conflict';
}

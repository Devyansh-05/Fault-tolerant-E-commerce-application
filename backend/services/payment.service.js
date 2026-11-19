/**
 * Simulated payment processing. NO real payment gateway is contacted and no real money moves.
 *
 * Stage 2 flow:
 *   checkout transaction  -> createPendingPayment()      (Payment PENDING, reference PAY-<orderId>)
 *   Payment Consumer      -> chargeOrderPayment()        (PENDING -> SUCCEEDED | FAILED, once)
 *   Order saga (compensation) -> refundOrderPayment()    (SUCCEEDED -> REFUNDED, once)
 *
 * Duplicate-charge protection (defence in depth):
 *  1. unique paymentReference (one payment operation per order)
 *  2. conditional state transitions (only a PENDING payment can be charged; only a SUCCEEDED
 *     one can be refunded) — a repeated event finds nothing to update
 *  3. the simulated gateway is idempotent per reference (same reference -> same transaction id),
 *     mirroring how real gateways accept idempotency keys
 *  4. the Reliable Event Processor's event idempotency (Redis + MongoDB)
 */
import { createHash } from 'node:crypto';
import { config } from '../config/env.js';
import { Payment, PAYMENT_RECORD_STATUS } from '../models/index.js';
import { CURRENCY } from '../utils/money.js';

export const buildPaymentReference = (orderId) => `PAY-${String(orderId)}`;

const deterministicId = (prefix, reference) =>
  `${prefix}-${createHash('sha256').update(reference).digest('hex').slice(0, 20).toUpperCase()}`;

/** Stand-in for an external gateway. Idempotent per reference. */
export const simulatedGateway = {
  async charge({ reference, amount }) {
    if (amount > config.payment.declineAbove) {
      return { approved: false, transactionId: deterministicId('SIMDECL', reference), reason: `Amount exceeds the simulated card limit (${config.payment.declineAbove})` };
    }
    return { approved: true, transactionId: deterministicId('SIM', reference) };
  },
  async refund({ reference }) {
    return { refunded: true, refundId: deterministicId('SIMREF', reference) };
  },
};

/** Called inside the checkout transaction: records the payment operation as PENDING. */
export async function createPendingPayment({ orderId, userId, amount }, session) {
  const [payment] = await Payment.create(
    [
      {
        orderId,
        userId,
        amount,
        currency: CURRENCY,
        paymentReference: buildPaymentReference(orderId),
        method: 'SIMULATED',
        paymentStatus: PAYMENT_RECORD_STATUS.PENDING,
      },
    ],
    { session }
  );
  return payment;
}

/**
 * Charges the order's payment exactly once (Payment Consumer, inside its transaction).
 * @returns {{ outcome: 'SUCCEEDED'|'FAILED'|'ALREADY_PROCESSED', payment, reason? }}
 */
export async function chargeOrderPayment(orderId, eventId, session) {
  const payment = await Payment.findOne({ orderId }).session(session);
  if (!payment) return { outcome: 'NOT_FOUND', payment: null };
  if (payment.paymentStatus !== PAYMENT_RECORD_STATUS.PENDING) return { outcome: 'ALREADY_PROCESSED', payment };

  // Amount comes from the database record, never from the event payload.
  const result = await simulatedGateway.charge({ reference: payment.paymentReference, amount: payment.amount });
  const status = result.approved ? PAYMENT_RECORD_STATUS.SUCCEEDED : PAYMENT_RECORD_STATUS.FAILED;

  const updated = await Payment.findOneAndUpdate(
    { _id: payment._id, paymentStatus: PAYMENT_RECORD_STATUS.PENDING },
    {
      $set: {
        paymentStatus: status,
        gatewayTransactionId: result.transactionId,
        failureReason: result.approved ? '' : result.reason,
        processedAt: new Date(),
        processedByEventId: eventId,
      },
    },
    { new: true, session }
  );
  if (!updated) return { outcome: 'ALREADY_PROCESSED', payment };
  return { outcome: status, payment: updated, reason: result.reason };
}

/** Compensation: refunds a SUCCEEDED payment exactly once. Returns true if a refund happened. */
export async function refundOrderPayment(orderId, session) {
  const payment = await Payment.findOne({ orderId, paymentStatus: PAYMENT_RECORD_STATUS.SUCCEEDED }).session(session);
  if (!payment) return false;
  const { refundId } = await simulatedGateway.refund({ reference: payment.paymentReference });
  const result = await Payment.updateOne(
    { _id: payment._id, paymentStatus: PAYMENT_RECORD_STATUS.SUCCEEDED },
    { $set: { paymentStatus: PAYMENT_RECORD_STATUS.REFUNDED, refundedAt: new Date(), refundReference: refundId } },
    { session }
  );
  return result.modifiedCount === 1;
}

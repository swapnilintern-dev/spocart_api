// Razorpay webhooks. Mounted BEFORE express.json() so the raw body is available
// for signature verification. Always 200 once handled so Razorpay stops retrying.
import express, { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { markCaptured, markFailed, markRefunded, verifyWebhookSignature } from '../services/payments.js';

const r = Router();

r.post('/razorpay', express.raw({ type: '*/*', limit: '1mb' }), asyncHandler(async (req, res) => {
  if (!verifyWebhookSignature(req.body, req.get('X-Razorpay-Signature'))) {
    req.log?.warn('Razorpay webhook with bad signature');
    return res.status(400).json({ ok: false, message: 'Invalid signature' });
  }

  const event = JSON.parse(req.body.toString('utf8'));
  req.log?.info({ event: event.event }, 'razorpay webhook');

  switch (event.event) {
    case 'payment.captured': {
      const p = event.payload.payment.entity;
      const order = await prisma.order.findUnique({ where: { razorpayOrderId: p.order_id } });
      if (order) {
        await markCaptured({ order, razorpayPaymentId: p.id, amount: BigInt(p.amount), method: p.method, raw: p, source: 'webhook' });
      }
      break;
    }
    case 'payment.failed':
      await markFailed(event.payload.payment.entity);
      break;
    case 'refund.processed':
      await markRefunded(event.payload.refund.entity);
      break;
    default:
      break;
  }
  res.json({ received: true });
}));

export default r;

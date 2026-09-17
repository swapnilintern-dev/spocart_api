// Orders that never completed payment are cancelled after UNPAID_ORDER_TTL_MINUTES
// so they don't clutter the buyer's list or the ops queue.
import cron from 'node-cron';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { minutesAgo } from '../utils/dates.js';

export function startExpireUnpaidJob() {
  cron.schedule('*/5 * * * *', async () => {
    const stale = await prisma.order.findMany({
      where: { status: 'paymentPending', placedAt: { lt: minutesAgo(env.UNPAID_ORDER_TTL_MINUTES) } },
      select: { id: true },
    });
    for (const { id } of stale) {
      await prisma.order.update({
        where: { id },
        data: { status: 'cancelled', statusUpdatedAt: new Date(), history: { create: { status: 'cancelled', note: 'Payment not completed' } } },
      });
    }
    if (stale.length) console.log(`expireUnpaid: cancelled ${stale.length} unpaid order(s)`);
  });
}

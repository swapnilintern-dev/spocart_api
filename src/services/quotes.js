import { prisma } from '../db/prisma.js';
import { ApiError } from '../middleware/error.js';
import { nextId } from './ids.js';
import { notify } from './notify.js';
import { toRupees } from '../utils/money.js';
import { absoluteUrl } from './orders.js';

export const quoteInclude = { items: { orderBy: { id: 'asc' } } };

export function serializeQuote(q) {
  return {
    id: q.id,
    kind: q.kind,
    createdAt: q.createdAt,
    status: q.status,
    notes: q.notes,
    quotedTotal: q.quotedTotal == null ? null : toRupees(q.quotedTotal),
    adminNote: q.adminNote,
    designFileName: q.designFileUrl ? q.designFileUrl.split('/').pop() : null,
    designFileUrl: absoluteUrl(q.designFileUrl),
    source: q.source,
    items: q.items.map((i) => ({ description: i.description, quantity: i.quantity, productId: i.productId, size: i.size })),
  };
}

export async function submitQuote(user, { kind, items, notes, designFileUrl, contactName, contactMobile }) {
  if (!user && !contactMobile) throw new ApiError(400, 'Please add a contact mobile number.');
  return prisma.$transaction(async (tx) => {
    const id = await nextId(tx, 'QT');
    const quote = await tx.quote.create({
      data: {
        id,
        userId: user?.id ?? null,
        kind,
        notes: notes ?? '',
        designFileUrl: designFileUrl ?? null,
        source: user ? 'app' : 'web',
        contactName: contactName ?? user?.profile?.contactName ?? null,
        contactMobile: contactMobile ?? user?.mobile ?? null,
        items: { create: items },
      },
      include: quoteInclude,
    });
    if (user) {
      await notify(tx, user.id, {
        type: 'quote', title: 'Quotation Request Received',
        body: `${id} is with our team. We usually respond within one business day.`, quoteId: id,
      });
    }
    return quote;
  });
}

export async function respondToQuote(quoteId, { quotedTotalPaise, adminNote }) {
  const quote = await prisma.quote.findUnique({ where: { id: quoteId } });
  if (!quote) throw new ApiError(404, 'Quote not found.');
  return prisma.$transaction(async (tx) => {
    const updated = await tx.quote.update({
      where: { id: quoteId },
      data: { status: 'quoted', quotedTotal: quotedTotalPaise, adminNote },
      include: quoteInclude,
    });
    if (quote.userId) {
      await notify(tx, quote.userId, {
        type: 'quote', title: 'Your Quotation Is Ready',
        body: `${quoteId}: ₹${toRupees(quotedTotalPaise).toLocaleString('en-IN')} incl. GST. Open to accept.`, quoteId,
      });
    }
    return updated;
  });
}

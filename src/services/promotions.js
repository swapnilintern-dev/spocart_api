// Offers and announcements, entirely controlled from the admin panel: nothing
// about a promotion is hardcoded in the app, so turning one on or off is a
// database change and not a release.
import { prisma } from '../db/prisma.js';
import { absoluteUrl } from './orders.js';

/**
 * The one promotion to show a buyer right now: live, inside its window, and
 * meant for them. Highest priority wins, newest breaks a tie.
 * [user] may be null — the home screen renders before sign-in.
 */
export async function activePromotion(user) {
  const now = new Date();
  const audiences = ['all'];
  if (user) audiences.push(user.profile ? 'registered' : 'unregistered');

  const row = await prisma.promotion.findFirst({
    where: {
      active: true,
      startsAt: { lte: now },
      endsAt: { gte: now },
      audience: { in: audiences },
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  });
  return row ? serializePromotion(row) : null;
}

export const serializePromotion = (p) => ({
  id: p.id,
  title: p.title,
  body: p.body,
  imageUrl: absoluteUrl(p.imageUrl),
  linkType: p.linkType,
  linkTarget: p.linkTarget,
  audience: p.audience,
  startsAt: p.startsAt.toISOString(),
  endsAt: p.endsAt.toISOString(),
  priority: p.priority,
  active: p.active,
});

/**
 * A promotion's destination is checked on write, so the app never has to decide
 * whether a link is safe to follow. Returns the value to store.
 */
export async function validateLink(linkType, linkTarget) {
  if (linkType === 'none') return null;
  const target = (linkTarget ?? '').trim();
  if (!target) throw Object.assign(new Error('Choose what this promotion opens.'), { status: 400 });

  if (linkType === 'product') {
    const exists = await prisma.product.findUnique({ where: { id: target }, select: { id: true } });
    if (!exists) throw Object.assign(new Error(`No product with id "${target}".`), { status: 400 });
    return target;
  }
  if (linkType === 'category') {
    const exists = await prisma.category.findUnique({ where: { id: target }, select: { id: true } });
    if (!exists) throw Object.assign(new Error(`No category with id "${target}".`), { status: 400 });
    return target;
  }

  // Only plain https links leave the app, so a promotion can never carry a
  // javascript:, intent: or file: URL to a buyer's device.
  let url;
  try {
    url = new URL(target);
  } catch {
    throw Object.assign(new Error('Enter a full link starting with https://'), { status: 400 });
  }
  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('Only https links are allowed.'), { status: 400 });
  }
  return url.toString();
}

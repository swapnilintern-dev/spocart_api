// Sample data, so every feature can be seen working before the real catalogue
// arrives. Safe to run more than once: each step checks what is already there
// and only fills what is missing.
//
//   node prisma/seed-samples.js            # say what it would do
//   node prisma/seed-samples.js --apply    # do it
//   node prisma/seed-samples.js --apply --remove   # take the samples back out
//
// Everything written here is a stand-in and is meant to be replaced:
//   • images reuse the catalogue photos already on this server
//   • barcodes are generated with a valid EAN-13 check digit, but they are not
//     the codes printed on your cartons
//   • the product video is a placeholder link, not a brand video
//   • the offer, gift tiers and reward rates are examples of the shape, not the
//     business's decisions
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const REMOVE = process.argv.includes('--remove');

const log = (step, detail) => console.log(`  ${step.padEnd(24)} ${detail}`);

/** A photo that suits the category, from what this server already serves. */
const IMAGE_BY_CATEGORY = {
  badminton: 'hero_badminton.jpg',
  basketball: 'gym_studio.jpg',
  cricket: 'cricket_ball.jpg',
  football: 'footballs_stack.jpg',
  hockey: 'runners_group.jpg',
  'table-tennis': 'tennis_clay.jpg',
  volleyball: 'gym_studio.jpg',
  swimming: 'swimmer.jpg',
  gym: 'gym_dumbbells.jpg',
  fitness: 'fitness_accessories.jpg',
  athletics: 'runners_group.jpg',
};
const FALLBACK_IMAGE = 'warehouse_aisle.jpg';

/** EAN-13 with a correct check digit, derived from the product id so it is stable. */
function sampleBarcode(productId) {
  let hash = 0;
  for (const ch of productId) hash = (hash * 31 + ch.charCodeAt(0)) % 100000000000;
  const body = `890${String(hash).padStart(9, '0').slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + String((10 - (sum % 10)) % 10);
}

async function images() {
  const missing = await prisma.product.findMany({
    where: { images: { equals: [] } },
    select: { id: true, categoryId: true },
  });
  if (missing.length === 0) return log('images', 'already set on every product');
  if (!APPLY) return log('images', `${missing.length} products would get one`);

  for (const p of missing) {
    const file = IMAGE_BY_CATEGORY[p.categoryId] ?? FALLBACK_IMAGE;
    await prisma.product.update({
      where: { id: p.id },
      data: { images: [`/uploads/catalog/${file}`] },
    });
  }
  log('images', `set on ${missing.length} products`);
}

async function barcodes() {
  const missing = await prisma.product.findMany({
    where: { barcode: null },
    select: { id: true },
  });
  if (missing.length === 0) return log('barcodes', 'already set on every product');
  if (!APPLY) return log('barcodes', `${missing.length} products would get one`);

  let done = 0;
  for (const p of missing) {
    try {
      await prisma.product.update({
        where: { id: p.id },
        data: { barcode: sampleBarcode(p.id) },
      });
      done++;
    } catch (e) {
      if (e.code !== 'P2002') throw e; // another product already took that code
    }
  }
  log('barcodes', `set on ${done} products`);
}

/** Stock on a handful, two of them low enough to show "Only N left". */
const STOCK = { 'fb-match-ball-5': 6, 'ck-ss-ball': 14, 'bd-graphite-racket': 120, 'sw-silicone-cap': 85 };

async function stock() {
  if (!APPLY) return log('stock', `${Object.keys(STOCK).length} products would get a count`);
  for (const [id, qty] of Object.entries(STOCK)) {
    await prisma.product.updateMany({ where: { id }, data: { stockQty: qty } });
  }
  log('stock', `tracked on ${Object.keys(STOCK).length} products (2 low)`);
}

/**
 * A placeholder video on one product, only so the video section can be seen
 * working. Replace it with the brand's own clip.
 */
const SAMPLE_VIDEO = { id: 'ck-kashmir-willow-bat', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' };

async function video() {
  if (!APPLY) return log('video', `placeholder would go on ${SAMPLE_VIDEO.id}`);
  await prisma.product.updateMany({
    where: { id: SAMPLE_VIDEO.id },
    data: { videoUrl: SAMPLE_VIDEO.url },
  });
  log('video', `placeholder on ${SAMPLE_VIDEO.id} — replace with a brand video`);
}

/** Drops two prices through the same path the admin screen uses, so the change
 *  is recorded and the Deals shelf has something real to show. */
const DROPS = { 'ck-english-willow-bat': 0.85, 'bd-graphite-racket': 0.9 };

async function priceDrops() {
  // Only ever drop a price once: running this again must not mark the same
  // product down a second time.
  const already = await prisma.priceChange.findMany({
    where: { productId: { in: Object.keys(DROPS) } },
    select: { productId: true },
  });
  const done_ = new Set(already.map((p) => p.productId));
  const todo = Object.entries(DROPS).filter(([id]) => !done_.has(id));

  if (todo.length === 0) return log('price drops', 'already marked down');
  if (!APPLY) return log('price drops', `${todo.length} products would drop`);
  const { recordPriceChange, entryPrice } = await import('../src/services/deals.js');

  let done = 0;
  for (const [id, factor] of todo) {
    const tiers = await prisma.productTier.findMany({ where: { productId: id } });
    if (tiers.length === 0) continue;
    const before = entryPrice(tiers);

    await prisma.$transaction(async (tx) => {
      for (const tier of tiers) {
        await tx.productTier.update({
          where: { productId_minQty: { productId: id, minQty: tier.minQty } },
          data: { unitPrice: BigInt(Math.round(Number(tier.unitPrice) * factor)) },
        });
      }
      const after = await tx.productTier.findMany({ where: { productId: id } });
      await recordPriceChange(tx, id, before, entryPrice(after));
    });
    done++;
  }
  log('price drops', `${done} products marked down and recorded`);
}

async function promotion() {
  const live = await prisma.promotion.count({ where: { active: true } });
  if (live > 0) return log('offer', `${live} already live`);
  if (!APPLY) return log('offer', 'one would be created');

  const now = new Date();
  const ends = new Date(now);
  ends.setMonth(ends.getMonth() + 1);
  await prisma.promotion.create({
    data: {
      title: 'Season Stock-Up',
      body: 'Extra savings on bulk orders this month. Tap to see what has come down in price.',
      imageUrl: '/uploads/catalog/warehouse_aisle.jpg',
      linkType: 'category',
      linkTarget: 'cricket',
      audience: 'all',
      startsAt: now,
      endsAt: ends,
      priority: 10,
      active: true,
    },
  });
  log('offer', 'created, live for one month');
}

const TIERS = [
  { name: 'Silver', giftLabel: 'Branded cap + bottle', threshold: 5000000n, sortOrder: 1, description: 'For shops ordering regularly.' },
  { name: 'Gold', giftLabel: 'Free kit bag', threshold: 15000000n, sortOrder: 2, description: 'For academies stocking a full season.' },
  { name: 'Platinum', giftLabel: 'Team kit for 11', threshold: 30000000n, sortOrder: 3, description: 'For our largest institutional buyers.' },
];

async function rewards() {
  const existing = await prisma.rewardTier.count();
  if (!APPLY) return log('rewards', existing ? `${existing} tiers already` : '3 tiers would be created, programme switched on');

  if (existing === 0) {
    for (const tier of TIERS) await prisma.rewardTier.create({ data: tier });
  }
  await prisma.rewardSettings.upsert({
    where: { id: 'default' },
    create: {
      id: 'default', mode: 'both', creditsPer100Rupees: 2, creditPaiseValue: 25,
      dailyCheckInCredits: 10, referralCredits: 200, maxRedeemPercent: 10, active: true,
    },
    update: {
      mode: 'both', creditsPer100Rupees: 2, creditPaiseValue: 25,
      dailyCheckInCredits: 10, referralCredits: 200, maxRedeemPercent: 10, active: true,
    },
  });
  log('rewards', `${TIERS.length} tiers, programme on (₹100 = 2 credits, 1 credit = ₹0.25)`);
}

const REVIEWS = [
  { rating: 5, title: 'Held up all season', body: 'We bought these for our under-14 squad and they have taken a beating without splitting. Delivery was on time.' },
  { rating: 4, title: 'Good value in bulk', body: 'Quality is consistent across the lot. The grip wears a little faster than we expected, otherwise no complaints.' },
];

/**
 * Reviews need a delivered order, because the server checks that rather than
 * trusting anyone. So: deliver one order, then review what was in it — exactly
 * the path a real buyer takes.
 */
/**
 * Recomputes every product's rating from its approved reviews. The seed data
 * shipped with made-up numbers (4.5 stars, 124 reviews) on products nobody has
 * reviewed; after this a product's stars always have reviews behind them.
 */
async function ratings() {
  const stale = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM products p
    WHERE p.review_count > 0
      AND NOT EXISTS (
        SELECT 1 FROM reviews r WHERE r.product_id = p.id AND r.status = 'approved'
      )`;
  const count = stale[0]?.n ?? 0;
  if (count === 0) return log('ratings', 'every rating already has reviews behind it');
  if (!APPLY) return log('ratings', `${count} products show a rating nobody gave`);

  await prisma.$executeRaw`
    UPDATE products p SET
      review_count = COALESCE(agg.n, 0),
      rating = COALESCE(agg.avg, 0)
    FROM (
      SELECT p2.id,
             count(r.*)::int AS n,
             round(avg(r.rating)::numeric, 1) AS avg
      FROM products p2
      LEFT JOIN reviews r ON r.product_id = p2.id AND r.status = 'approved'
      GROUP BY p2.id
    ) agg
    WHERE agg.id = p.id`;
  log('ratings', `${count} made-up ratings cleared; stars now come from reviews`);
}

async function reviews() {
  const existing = await prisma.review.count();
  if (existing > 0) return log('reviews', `${existing} already written`);

  const order = await prisma.order.findFirst({
    where: { status: { in: ['placed', 'packed', 'dispatched', 'outForDelivery', 'delivered'] } },
    include: { items: true },
    orderBy: { placedAt: 'asc' },
  });
  if (!order) return log('reviews', 'no order to review — place one first');
  if (!APPLY) return log('reviews', `${order.id} would be delivered and reviewed`);

  if (order.status !== 'delivered') {
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'delivered',
        statusUpdatedAt: new Date(),
        history: { create: { status: 'delivered', note: 'Sample data' } },
      },
    });
  }

  const { upsertReview } = await import('../src/services/reviews.js');
  const buyer = await prisma.user.findUnique({ where: { id: order.userId } });

  let written = 0;
  for (const [i, line] of order.items.slice(0, REVIEWS.length).entries()) {
    await upsertReview(buyer, line.productId, REVIEWS[i]);
    written++;
  }
  log('reviews', `${order.id} delivered, ${written} reviews written by its buyer`);
}

/** Puts back what the samples changed, so the real catalogue starts clean. */
async function removeSamples() {
  const barcodes = await prisma.product.updateMany({
    where: { barcode: { startsWith: '890' } },
    data: { barcode: null },
  });
  const stockCleared = await prisma.product.updateMany({
    where: { id: { in: Object.keys(STOCK) } },
    data: { stockQty: null },
  });
  const videoCleared = await prisma.product.updateMany({
    where: { videoUrl: SAMPLE_VIDEO.url },
    data: { videoUrl: null },
  });
  const offers = await prisma.promotion.deleteMany({ where: { title: 'Season Stock-Up' } });
  const claims = await prisma.rewardClaim.deleteMany({});
  const tiers = await prisma.rewardTier.deleteMany({ where: { name: { in: TIERS.map((t) => t.name) } } });
  const credits = await prisma.creditEntry.deleteMany({});
  await prisma.rewardSettings.updateMany({
    where: { id: 'default' },
    data: {
      mode: 'purchase', creditsPer100Rupees: 0, creditPaiseValue: 0,
      dailyCheckInCredits: 0, referralCredits: 0, maxRedeemPercent: 0, active: false,
    },
  });

  log('barcodes', `${barcodes.count} cleared`);
  log('stock', `${stockCleared.count} cleared`);
  log('video', `${videoCleared.count} cleared`);
  log('offer', `${offers.count} removed`);
  log('rewards', `${tiers.count} tiers, ${claims.count} claims, ${credits.count} ledger entries removed; programme off`);
  console.log('\n  Images, price history and reviews were left alone — they are not');
  console.log('  harmful to keep, and reviews belong to the buyers who wrote them.');
}

async function main() {
  console.log(`\nSPOCART sample data — ${REMOVE ? 'REMOVING' : APPLY ? 'APPLYING' : 'DRY RUN (add --apply to write)'}\n`);
  if (REMOVE) {
    if (!APPLY) {
      console.log('  --remove needs --apply as well.\n');
      return;
    }
    await removeSamples();
  } else {
    await images();
    await barcodes();
    await stock();
    await video();
    await priceDrops();
    await promotion();
    await rewards();
    await reviews();
    await ratings();
  }
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

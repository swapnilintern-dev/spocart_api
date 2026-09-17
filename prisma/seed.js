// Seeds categories + products from prisma/seed-data.json (ported from the
// Flutter app's demo catalogue; prices already in paise). Safe to re-run.
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const { categories, products } = JSON.parse(
  readFileSync(new URL('./seed-data.json', import.meta.url), 'utf8'),
);

for (const c of categories) {
  await prisma.category.upsert({ where: { id: c.id }, create: c, update: c });
}

for (const { tiers, ...p } of products) {
  await prisma.product.upsert({ where: { id: p.id }, create: p, update: p });
  await prisma.productTier.deleteMany({ where: { productId: p.id } });
  await prisma.productTier.createMany({
    data: tiers.map(([minQty, unitPrice]) => ({ productId: p.id, minQty, unitPrice: BigInt(unitPrice) })),
  });
}

console.log(`Seeded ${categories.length} categories and ${products.length} products.`);
await prisma.$disconnect();

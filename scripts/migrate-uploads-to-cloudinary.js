// One-time migration: moves everything under uploads/ to Cloudinary and rewrites
// the stored URLs (products.images, categories.imageUrl, order_items.image,
// quotes.designFileUrl). Safe to run more than once — already-migrated rows are
// skipped, and nothing is deleted from disk.
//
//   node scripts/migrate-uploads-to-cloudinary.js            (dry run)
//   node scripts/migrate-uploads-to-cloudinary.js --apply    (writes)
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/db/prisma.js';
import { storeFile, usingCloudinary } from '../src/services/storage.js';

const APPLY = process.argv.includes('--apply');
const isLocal = (u) => typeof u === 'string' && u.includes('/uploads/');
const base = (u) => path.basename(String(u).split('?')[0]);

async function uploadAll() {
  const map = new Map();                       // filename → cloudinary url
  for (const [dir, folder] of [['uploads/catalog', 'products'], ['uploads/designs', 'quotes']]) {
    let files = [];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const name of files.filter((f) => !f.startsWith('.'))) {
      const buffer = await fs.readFile(path.join(dir, name));
      if (!APPLY) { map.set(name, `(dry-run) spocart/${folder}/${name}`); continue; }
      const up = await storeFile({ buffer, originalname: name, size: buffer.length }, folder);
      map.set(name, up.url);
      console.log(`  uploaded ${dir}/${name} → ${up.url}`);
    }
  }
  return map;
}

async function main() {
  if (!usingCloudinary && APPLY) {
    console.error('CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET are not set — nothing to migrate to.');
    process.exit(1);
  }
  console.log(APPLY ? 'APPLY mode — uploading and rewriting URLs\n' : 'DRY RUN — nothing will be written (add --apply)\n');

  const map = await uploadAll();
  console.log(`\nfiles found: ${map.size}\n`);
  const urlFor = (u) => map.get(base(u));
  let changed = { products: 0, categories: 0, orderItems: 0, quotes: 0, missing: [] };

  for (const p of await prisma.product.findMany({ select: { id: true, images: true } })) {
    if (!p.images.some(isLocal)) continue;
    const images = p.images.map((i) => (isLocal(i) ? (urlFor(i) ?? (changed.missing.push(i), i)) : i));
    if (APPLY) await prisma.product.update({ where: { id: p.id }, data: { images } });
    changed.products++;
  }
  for (const c of await prisma.category.findMany({ select: { id: true, imageUrl: true } })) {
    if (!isLocal(c.imageUrl)) continue;
    const imageUrl = urlFor(c.imageUrl) ?? (changed.missing.push(c.imageUrl), c.imageUrl);
    if (APPLY) await prisma.category.update({ where: { id: c.id }, data: { imageUrl } });
    changed.categories++;
  }
  // Order lines keep a snapshot of the product photo — rewrite so old invoices still show it.
  for (const i of await prisma.orderItem.findMany({ where: { image: { contains: '/uploads/' } }, select: { id: true, image: true } })) {
    const image = urlFor(i.image) ?? (changed.missing.push(i.image), i.image);
    if (APPLY) await prisma.orderItem.update({ where: { id: i.id }, data: { image } });
    changed.orderItems++;
  }
  for (const q of await prisma.quote.findMany({ where: { designFileUrl: { contains: '/uploads/' } }, select: { id: true, designFileUrl: true } })) {
    const designFileUrl = urlFor(q.designFileUrl) ?? (changed.missing.push(q.designFileUrl), q.designFileUrl);
    if (APPLY) await prisma.quote.update({ where: { id: q.id }, data: { designFileUrl } });
    changed.quotes++;
  }

  console.log('rows to update:', { products: changed.products, categories: changed.categories, orderItems: changed.orderItems, quotes: changed.quotes });
  if (changed.missing.length) console.log('\n⚠️  no local file found for:', [...new Set(changed.missing)]);
  console.log(APPLY ? '\nDone.' : '\nDry run complete — re-run with --apply to write.');
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

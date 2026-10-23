// Sets each product's photo from uploads/catalog/<product-id>.jpg and replaces
// products.images with it. Products without a matching file are left alone.
//
// The filename IS the product id, so a photo cannot end up on the wrong
// product: there is no mapping to get wrong. On Cloudinary the asset is stored
// under that same id, so the URL names its product too, and a product already
// pointing at its own asset is skipped — safe to re-run.
//
// Two ways to host the photo:
//   default   upload the file to Cloudinary (needs the CLOUDINARY_* variables)
//   --local   point the product at /uploads/catalog/<file>, which the API serves
//             from this repo. Deploy first: each file must already answer on
//             PUBLIC_BASE_URL, or that product is skipped.
//
//   node scripts/set-product-photos.js [--local]            (dry run)
//   node scripts/set-product-photos.js [--local] --apply    (writes)
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/db/prisma.js';
import { storeFile, usingCloudinary } from '../src/services/storage.js';
import { env } from '../src/config/env.js';

const APPLY = process.argv.includes('--apply');
const LOCAL = process.argv.includes('--local');
const DIR = 'uploads/catalog';

/** True when the deployed API already serves this file. */
async function isServed(relative) {
  try {
    const res = await fetch(`${env.PUBLIC_BASE_URL}${relative}`, { method: 'HEAD' });
    return res.ok;
  } catch { return false; }
}

async function main() {
  if (APPLY && !LOCAL && !usingCloudinary) {
    console.error('CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET are not set — add --local to use the photos the API serves from uploads/.');
    process.exit(1);
  }
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN — nothing will be written (add --apply)'} · ${LOCAL ? `served from ${env.PUBLIC_BASE_URL}/${DIR}` : 'Cloudinary upload'}\n`);

  const files = new Set(await fs.readdir(DIR));
  const products = await prisma.product.findMany({ select: { id: true, images: true }, orderBy: { id: 'asc' } });
  let updated = 0;
  const missing = [];
  const notServed = [];
  const already = [];

  for (const p of products) {
    const name = `${p.id}.jpg`;
    if (!files.has(name)) { missing.push(p.id); continue; }
    const relative = `/${DIR}/${name}`;
    if (LOCAL && !(await isServed(relative))) { notServed.push(p.id); continue; }
    // Already pointing at this product's own named Cloudinary asset.
    if (!LOCAL && (p.images[0] ?? '').includes(`/spocart/products/${p.id}`)) { already.push(p.id); continue; }
    if (!APPLY) { console.log(`  ${p.id.padEnd(28)} ${(p.images[0] ?? '(none)').slice(-58).padEnd(58)}  →  ${LOCAL ? relative : `spocart/products/${p.id}`}`); updated++; continue; }

    let url = relative;
    if (!LOCAL) {
      const buffer = await fs.readFile(path.join(DIR, name));
      // public_id = the product id. The URL then names the product it belongs
      // to, and running this again replaces that asset rather than adding a
      // second copy.
      url = (await storeFile({ buffer, originalname: name, size: buffer.length }, 'products', { publicId: p.id })).url;
    }
    await prisma.product.update({ where: { id: p.id }, data: { images: [url] } });
    console.log(`  ${p.id.padEnd(28)} → ${url}`);
    updated++;
  }

  console.log(`\nproducts ${APPLY ? 'updated' : 'to update'}: ${updated} of ${products.length}`);
  if (already.length) console.log(`already on their own Cloudinary asset (skipped): ${already.length}`);
  if (missing.length) console.log('no photo file for:', missing);
  if (notServed.length) console.log(`not served by ${env.PUBLIC_BASE_URL} yet (deploy first):`, notServed);
  console.log(APPLY ? '\nDone.' : '\nDry run complete — re-run with --apply to write.');
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

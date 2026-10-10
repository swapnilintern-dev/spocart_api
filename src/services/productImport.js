// Bulk product import.
//
// A data-entry employee fills one sheet — every product, its price slabs and
// its Cloudinary image links — and an admin uploads it. Nothing about the sheet
// is clever: one row is one product, and every column is named after the field
// it fills, so the person typing never has to know the database.
//
// Two rules make it safe to hand to someone:
//
//   1. **Nothing is written until the whole sheet is valid.** A file with one
//      bad row changes nothing at all, and comes back saying which row and
//      which column. Half an import is worse than none.
//   2. **Every message names the row and the column.** "Row 14, tier2_price:
//      must be lower than tier1_price" is something the employee can fix
//      alone; "validation failed" is not.
//
// Re-uploading the same sheet is safe: a row whose id already exists updates
// that product rather than failing, so the sheet stays the source of truth and
// can be corrected and sent again.
import ExcelJS from 'exceljs';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../middleware/error.js';
import { validateTiers } from './pricing.js';
import { canonicalImageUrl } from './storage.js';
import { canonicalVideoUrl } from './videoUrl.js';
import { recordPriceChange, entryPrice } from './deals.js';
import { clearBestSellerCache } from './bestSellers.js';

/** How many price slabs and images one row may carry. */
export const MAX_TIERS = 5;
export const MAX_IMAGES = 5;

const UNITS = ['pc', 'pair', 'set', 'box'];

/**
 * The sheet's columns, in the order they appear. `required` is what the
 * employee must fill; everything else may be left blank.
 */
export const COLUMNS = [
  { key: 'id', required: true, help: 'Short code, lowercase, words joined by hyphens, e.g. ck-kashmir-willow-bat. Re-using one updates that product.' },
  { key: 'categoryId', required: true, help: 'One of the category ids listed on the Reference sheet.' },
  { key: 'subcategory', required: true, help: 'One of that category\'s sub-categories, spelled exactly as listed.' },
  { key: 'name', required: true, help: 'What the buyer sees, e.g. Kashmir Willow Cricket Bat.' },
  { key: 'brand', required: true, help: 'e.g. SS, Nivia, Yonex.' },
  { key: 'unit', required: true, help: `One of: ${UNITS.join(', ')}.` },
  { key: 'moq', required: true, help: 'Minimum order quantity, a whole number.' },
  { key: 'tier1_minQty', required: true, help: 'Must equal the MOQ.' },
  { key: 'tier1_price', required: true, help: 'Price per unit in rupees at that quantity.' },
  { key: 'tier2_minQty', help: 'Next slab. Leave the pair blank if there is only one price.' },
  { key: 'tier2_price', help: 'Must be LOWER than tier1_price.' },
  { key: 'tier3_minQty' },
  { key: 'tier3_price' },
  { key: 'tier4_minQty' },
  { key: 'tier4_price' },
  { key: 'tier5_minQty' },
  { key: 'tier5_price' },
  { key: 'image1', required: true, help: 'Cloudinary link to the main photo (https://res.cloudinary.com/...).' },
  { key: 'image2' },
  { key: 'image3' },
  { key: 'image4' },
  { key: 'image5' },
  { key: 'description', help: 'A sentence or two for the product page.' },
  { key: 'sizes', help: 'Comma separated, e.g. SH, 6, 5, 4. Leave blank if the product has no sizes.' },
  { key: 'features', help: 'Comma separated selling points, e.g. Grade A willow, Hand picked.' },
  { key: 'stockQty', help: 'Units on hand. Leave blank to not track stock for this product.' },
  { key: 'barcode', help: 'The code printed on the box. Must be unique across all products.' },
  { key: 'videoUrl', help: 'A YouTube link, if there is an official video.' },
  { key: 'inStock', help: 'yes or no. Blank means yes.' },
  { key: 'popular', help: 'yes or no. Blank means no.' },
  { key: 'customisable', help: 'yes or no — can it be printed with a team name? Blank means no.' },
  { key: 'active', help: 'yes or no — show it in the app at all. Blank means yes.' },
];

const REQUIRED = COLUMNS.filter((c) => c.required).map((c) => c.key);

// ── reading a cell ───────────────────────────────────────────────────────────

/** Excel hands back dates, formulas and rich text; everything becomes a string. */
function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('text' in value) return String(value.text).trim();
    if ('result' in value) return String(value.result).trim();
    if ('richText' in value) return value.richText.map((r) => r.text).join('').trim();
    if ('hyperlink' in value) return String(value.hyperlink).trim();
  }
  return String(value).trim();
}

/** "yes" / "no" / "true" / "1" / blank → boolean, or null when unreadable. */
function boolCell(text, fallback) {
  const v = text.toLowerCase();
  if (v === '') return fallback;
  if (['yes', 'y', 'true', '1'].includes(v)) return true;
  if (['no', 'n', 'false', '0'].includes(v)) return false;
  return null;
}

function intCell(text) {
  if (text === '') return null;
  const n = Number(text.replace(/[, ]/g, ''));
  return Number.isInteger(n) ? n : NaN;
}

function moneyCell(text) {
  if (text === '') return null;
  const n = Number(text.replace(/[₹, ]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

const list = (text) =>
  text.split(',').map((s) => s.trim()).filter(Boolean);

// ── parsing a file into rows ─────────────────────────────────────────────────

/** Splits one CSV line, honouring quoted fields that contain commas. */
function csvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

function parseCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new ApiError(400, 'The sheet has no product rows.');
  const header = csvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line, i) => {
    const cells = csvLine(line);
    const row = { __line: i + 2 };
    header.forEach((h, c) => { row[h] = (cells[c] ?? '').trim(); });
    return row;
  });
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  // The products are on the first sheet; a Reference sheet may follow.
  const sheet = wb.worksheets[0];
  if (!sheet) throw new ApiError(400, 'That file has no sheets.');

  const header = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    header[col] = cellText(cell.value);
  });
  if (!header.includes('id')) {
    throw new ApiError(400, 'The first row must be the column headings from the template.');
  }

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (excelRow, index) => {
    if (index === 1) return;
    const row = { __line: index };
    let any = false;
    excelRow.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = header[col];
      if (!key) return;
      const text = cellText(cell.value);
      row[key] = text;
      if (text !== '') any = true;
    });
    if (any) rows.push(row);
  });
  if (rows.length === 0) throw new ApiError(400, 'The sheet has no product rows.');
  return rows;
}

/** Reads an uploaded .csv or .xlsx into plain rows keyed by column name. */
export async function parseSheet(file) {
  const name = (file?.originalname ?? '').toLowerCase();
  if (!file?.buffer?.length) throw new ApiError(400, 'No file received.');
  if (name.endsWith('.csv')) return parseCsv(file.buffer);
  if (name.endsWith('.xlsx')) return parseXlsx(file.buffer);
  throw new ApiError(400, 'Upload the filled template as .xlsx or .csv.');
}

// ── validating ───────────────────────────────────────────────────────────────

/**
 * Turns rows into products, collecting every problem rather than stopping at
 * the first: an employee should get one list to fix, not one error per upload.
 */
export async function validateRows(rows) {
  const categories = await prisma.category.findMany({
    select: { id: true, subcategories: true },
  });
  const byCategory = new Map(categories.map((c) => [c.id, c.subcategories]));

  const existing = await prisma.product.findMany({ select: { id: true, barcode: true } });
  const existingIds = new Set(existing.map((p) => p.id));
  const barcodeOwner = new Map(existing.filter((p) => p.barcode).map((p) => [p.barcode, p.id]));

  const errors = [];
  const products = [];
  const seenIds = new Map();
  const seenBarcodes = new Map();

  rows.forEach((row) => {
    const line = row.__line;
    const problem = (column, message) => errors.push({ line, column, message });
    const text = (key) => (row[key] ?? '').toString().trim();

    for (const key of REQUIRED) {
      if (text(key) === '') problem(key, 'is required');
    }

    const id = text('id').toLowerCase();
    if (id && !/^[a-z0-9-]+$/.test(id)) {
      problem('id', 'use lowercase letters, numbers and hyphens only, e.g. ck-willow-bat');
    }
    if (id && seenIds.has(id)) {
      problem('id', `the same id is already on row ${seenIds.get(id)}`);
    } else if (id) {
      seenIds.set(id, line);
    }

    const categoryId = text('categoryId');
    const subs = byCategory.get(categoryId);
    if (categoryId && !subs) {
      problem('categoryId', `no category "${categoryId}". Use one of: ${[...byCategory.keys()].join(', ')}`);
    }
    const subcategory = text('subcategory');
    if (subs && subcategory && !subs.includes(subcategory)) {
      problem('subcategory', `"${subcategory}" is not in ${categoryId}. Use one of: ${subs.join(', ')}`);
    }

    const unit = text('unit').toLowerCase();
    if (unit && !UNITS.includes(unit)) problem('unit', `must be one of: ${UNITS.join(', ')}`);

    const moq = intCell(text('moq'));
    if (moq !== null && (Number.isNaN(moq) || moq < 1)) {
      problem('moq', 'must be a whole number of 1 or more');
    }

    // Price slabs.
    const tiers = [];
    for (let t = 1; t <= MAX_TIERS; t++) {
      const qText = text(`tier${t}_minQty`);
      const pText = text(`tier${t}_price`);
      if (qText === '' && pText === '') continue;
      if (qText === '' || pText === '') {
        problem(`tier${t}_minQty`, 'fill both the quantity and the price, or leave both blank');
        continue;
      }
      const q = intCell(qText);
      const p = moneyCell(pText);
      if (Number.isNaN(q) || q === null || q < 1) problem(`tier${t}_minQty`, 'must be a whole number');
      else if (Number.isNaN(p) || p === null || p <= 0) problem(`tier${t}_price`, 'must be a price in rupees, e.g. 1800');
      else tiers.push({ minQty: q, unitPrice: BigInt(Math.round(p * 100)) });
    }
    if (tiers.length && moq !== null && !Number.isNaN(moq)) {
      const complaint = validateTiers(tiers, moq);
      if (complaint) problem('tier1_minQty', complaint.replace(/\.$/, ''));
    }

    // Images: Cloudinary links, or any https link.
    const images = [];
    for (let i = 1; i <= MAX_IMAGES; i++) {
      const url = text(`image${i}`);
      if (url === '') continue;
      if (!/^https:\/\/\S+$/i.test(url)) {
        problem(`image${i}`, 'must be a full https link — paste the Cloudinary URL');
      } else {
        images.push(canonicalImageUrl(url));
      }
    }

    const videoUrl = text('videoUrl');
    let video = null;
    if (videoUrl !== '') {
      video = canonicalVideoUrl(videoUrl);
      if (!video) problem('videoUrl', 'is not a YouTube link');
    }

    const barcode = text('barcode');
    if (barcode !== '') {
      if (!/^[A-Za-z0-9._-]{4,64}$/.test(barcode)) {
        problem('barcode', 'use 4–64 letters, digits, dots, dashes or underscores');
      }
      if (seenBarcodes.has(barcode)) {
        problem('barcode', `the same barcode is already on row ${seenBarcodes.get(barcode)}`);
      } else {
        seenBarcodes.set(barcode, line);
        const owner = barcodeOwner.get(barcode);
        if (owner && owner !== id) {
          problem('barcode', `already used by the product "${owner}"`);
        }
      }
    }

    const stockText = text('stockQty');
    const stockQty = intCell(stockText);
    if (stockText !== '' && (Number.isNaN(stockQty) || stockQty < 0)) {
      problem('stockQty', 'must be a whole number of 0 or more, or blank');
    }

    const flags = {};
    for (const [key, fallback] of [
      ['inStock', true], ['popular', false], ['customisable', false], ['active', true],
    ]) {
      const value = boolCell(text(key), fallback);
      if (value === null) problem(key, 'write yes or no');
      else flags[key] = value;
    }

    products.push({
      line,
      isUpdate: existingIds.has(id),
      data: {
        id,
        categoryId,
        subcategory,
        name: text('name'),
        brand: text('brand'),
        unit,
        moq,
        description: text('description'),
        images,
        sizes: list(text('sizes')),
        features: list(text('features')).map((label) => ({ label, icon: 'check' })),
        stockQty: stockText === '' ? null : stockQty,
        barcode: barcode === '' ? null : barcode,
        videoUrl: video,
        ...flags,
      },
      tiers,
    });
  });

  return { products, errors };
}

// ── applying ─────────────────────────────────────────────────────────────────

/**
 * Writes the sheet. One transaction for the whole file, so an import either
 * lands completely or not at all — the catalogue is never left half-updated.
 */
export async function applyImport(products) {
  const summary = { created: 0, updated: 0, priceDrops: 0 };

  await prisma.$transaction(async (tx) => {
    for (const { data, tiers, isUpdate } of products) {
      const before = isUpdate
        ? await tx.productTier.findMany({ where: { productId: data.id } })
        : [];

      await tx.product.upsert({
        where: { id: data.id },
        create: data,
        update: data,
      });

      await tx.productTier.deleteMany({ where: { productId: data.id } });
      await tx.productTier.createMany({
        data: tiers.map((t) => ({ ...t, productId: data.id })),
      });

      // A price moved by the sheet lands on the Deals shelf exactly like one
      // changed on the product screen.
      const change = await recordPriceChange(
        tx, data.id, entryPrice(before), entryPrice(tiers),
      );
      if (change && change.newPrice < change.oldPrice) summary.priceDrops++;

      if (isUpdate) summary.updated++;
      else summary.created++;
    }
  }, { timeout: 120_000 });

  clearBestSellerCache();
  return summary;
}

/**
 * The whole job: read, check, and write unless this is a dry run.
 * Returns what happened — or, when the sheet has problems, exactly what to fix.
 */
export async function importProducts(file, { dryRun = false } = {}) {
  const rows = await parseSheet(file);
  if (rows.length > 2000) {
    throw new ApiError(400, 'That is more than 2,000 rows. Split the sheet and upload it in parts.');
  }

  const { products, errors } = await validateRows(rows);

  if (errors.length) {
    return {
      ok: false,
      rows: rows.length,
      created: 0,
      updated: 0,
      errors: errors.slice(0, 200),
      errorCount: errors.length,
      message: `Nothing was imported. Fix ${errors.length} problem${errors.length === 1 ? '' : 's'} in the sheet and upload it again.`,
    };
  }

  const willCreate = products.filter((p) => !p.isUpdate).length;
  const willUpdate = products.length - willCreate;

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      rows: rows.length,
      created: willCreate,
      updated: willUpdate,
      errors: [],
      message: `The sheet is valid: ${willCreate} new product${willCreate === 1 ? '' : 's'} and ${willUpdate} update${willUpdate === 1 ? '' : 's'}. Nothing has been changed yet.`,
    };
  }

  const summary = await applyImport(products);
  return {
    ok: true,
    dryRun: false,
    rows: rows.length,
    ...summary,
    errors: [],
    message: `${summary.created} added, ${summary.updated} updated.`,
  };
}

// ── the template ─────────────────────────────────────────────────────────────

/**
 * The workbook to hand the data-entry employee: the columns in order, one
 * worked example, and a Reference sheet listing every category, its
 * sub-categories and what each column expects — so nobody has to be told.
 */
export async function templateWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SPOCART';
  wb.created = new Date();

  const sheet = wb.addWorksheet('Products');
  sheet.columns = COLUMNS.map((c) => ({
    header: c.key,
    key: c.key,
    width: Math.max(14, Math.min(34, c.key.length + 8)),
  }));

  const head = sheet.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B0B0C' } };
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.height = 20;
  // Required columns are marked so a blank one is obvious before upload.
  COLUMNS.forEach((c, i) => {
    if (c.required) head.getCell(i + 1).fill =
      { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4132B' } };
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  sheet.addRow({
    id: 'ck-kashmir-willow-bat',
    categoryId: 'cricket',
    subcategory: 'Bats',
    name: 'Kashmir Willow Cricket Bat',
    brand: 'SS',
    unit: 'pc',
    moq: 10,
    tier1_minQty: 10, tier1_price: 1800,
    tier2_minQty: 50, tier2_price: 1600,
    tier3_minQty: 100, tier3_price: 1400,
    image1: 'https://res.cloudinary.com/your-cloud/image/upload/v1/spocart/products/bat-front.jpg',
    image2: 'https://res.cloudinary.com/your-cloud/image/upload/v1/spocart/products/bat-back.jpg',
    description: 'Season-ready Kashmir willow bat for academy and club use.',
    sizes: 'SH, 6, 5, 4',
    features: 'Grade A willow, Hand picked, Short handle',
    stockQty: 120,
    barcode: '8901234567890',
    inStock: 'yes',
    popular: 'yes',
    customisable: 'no',
    active: 'yes',
  });

  const ref = wb.addWorksheet('Reference');
  ref.columns = [
    { header: 'Column', key: 'c', width: 20 },
    { header: 'Required', key: 'r', width: 10 },
    { header: 'What to put in it', key: 'h', width: 90 },
  ];
  ref.getRow(1).font = { bold: true };
  for (const c of COLUMNS) {
    ref.addRow({ c: c.key, r: c.required ? 'yes' : '', h: c.help ?? '' });
  }

  ref.addRow({});
  ref.addRow({ c: 'CATEGORIES', r: '', h: 'Use the id on the left. The sub-category must be one of the names on the right.' });
  const categories = await prisma.category.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, name: true, subcategories: true },
  });
  for (const c of categories) {
    ref.addRow({ c: c.id, r: '', h: `${c.name} — ${c.subcategories.join(', ')}` });
  }

  return wb;
}

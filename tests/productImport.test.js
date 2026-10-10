// Bulk product import. The point of these is the promise made to whoever
// uploads the sheet: a file with one bad row changes nothing, and every
// message names the row and the column so the employee can fix it alone.
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { importProducts, templateWorkbook, COLUMNS } from '../src/services/productImport.js';

const HEAD = 'id,categoryId,subcategory,name,brand,unit,moq,tier1_minQty,tier1_price,tier2_minQty,tier2_price,image1,sizes,features,stockQty,barcode,videoUrl,inStock';
const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/x.jpg';

const row = (over = {}) => {
  const d = {
    id: 'vitest-bat', categoryId: 'cricket', subcategory: 'Bats',
    name: 'Vitest Bat', brand: 'SS', unit: 'pc', moq: '10',
    tier1_minQty: '10', tier1_price: '1800', tier2_minQty: '50', tier2_price: '1600',
    image1: IMG, sizes: '', features: '', stockQty: '', barcode: '', videoUrl: '', inStock: 'yes',
    ...over,
  };
  return HEAD.split(',').map((k) => cell(d[k] ?? '')).join(',');
};

const sheet = (...rows) => ({
  originalname: 'products.csv',
  buffer: Buffer.from([HEAD, ...rows].join('\n'), 'utf8'),
});

/** Quotes a field the way Excel does, so a value with commas stays one cell. */
const cell = (v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

async function cleanup() {
  const ids = (await prisma.product.findMany({
    where: { id: { startsWith: 'vitest-' } }, select: { id: true },
  })).map((p) => p.id);
  if (ids.length === 0) return;
  await prisma.priceChange.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productTier.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
}

afterEach(cleanup);
afterAll(cleanup);

describe('the template', () => {
  it('carries the columns and a reference sheet', async () => {
    const wb = await templateWorkbook();
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Products', 'Reference']);

    const header = wb.getWorksheet('Products').getRow(1).values.slice(1);
    expect(header).toEqual(COLUMNS.map((c) => c.key));
    // One worked example, so nobody has to guess the shape.
    expect(wb.getWorksheet('Products').rowCount).toBeGreaterThan(1);
    // Every live category is listed for the employee.
    const categories = await prisma.category.count({ where: { active: true } });
    expect(wb.getWorksheet('Reference').rowCount).toBeGreaterThan(COLUMNS.length + categories);
  });
});

describe('a sheet with problems', () => {
  it('changes nothing at all, even if most rows are fine', async () => {
    const result = await importProducts(sheet(
      row({ id: 'vitest-good-1' }),
      row({ id: 'vitest-good-2' }),
      row({ id: 'vitest-bad', subcategory: 'Nonsense' }),
    ));
    expect(result.ok).toBe(false);
    expect(result.created).toBe(0);
    expect(await prisma.product.count({ where: { id: { startsWith: 'vitest-' } } })).toBe(0);
  });

  it('names the row and the column every time', async () => {
    const result = await importProducts(sheet(
      row({ id: 'Bad Id!' }),
      row({ id: 'vitest-b', categoryId: 'criket' }),
      row({ id: 'vitest-c', subcategory: 'Shoes' }),
      row({ id: 'vitest-d', tier1_minQty: '24' }),
      row({ id: 'vitest-e', tier2_price: '2000' }),
      row({ id: 'vitest-f', image1: 'not-a-link' }),
      row({ id: 'vitest-g', unit: 'dozen' }),
      row({ id: 'vitest-h', inStock: 'maybe' }),
      row({ id: '' }),
    ));
    expect(result.ok).toBe(false);
    for (const e of result.errors) {
      expect(e.line).toBeGreaterThan(1);
      expect(e.column).toBeTruthy();
      expect(e.message).toBeTruthy();
    }
    const columns = result.errors.map((e) => e.column);
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'categoryId', 'subcategory', 'tier1_minQty', 'image1', 'unit', 'inStock',
    ]));
  });

  it('catches an id or a barcode repeated inside the same sheet', async () => {
    const dupId = await importProducts(sheet(row({ id: 'vitest-x' }), row({ id: 'vitest-x' })));
    expect(dupId.errors.some((e) => e.column === 'id' && /already on row/.test(e.message))).toBe(true);

    const dupBar = await importProducts(sheet(
      row({ id: 'vitest-y', barcode: '7771110000011' }),
      row({ id: 'vitest-z', barcode: '7771110000011' }),
    ));
    expect(dupBar.errors.some((e) => e.column === 'barcode')).toBe(true);
  });

  it('refuses a file that is not the template', async () => {
    await expect(importProducts({ originalname: 'photo.png', buffer: Buffer.from('x') }))
      .rejects.toThrow(/\.xlsx or \.csv/i);
    await expect(importProducts({ originalname: 'empty.csv', buffer: Buffer.from(HEAD) }))
      .rejects.toThrow(/no product rows/i);
  });
});

describe('a valid sheet', () => {
  it('reports what would happen without writing, on a dry run', async () => {
    const result = await importProducts(sheet(row()), { dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.created).toBe(1);
    expect(await prisma.product.count({ where: { id: 'vitest-bat' } })).toBe(0);
  });

  it('creates the product with everything the row carried', async () => {
    await importProducts(sheet(row({
      sizes: 'SH, 6, 5',
      features: 'Grade A willow',
      stockQty: '15',
      barcode: '7771110000099',
      videoUrl: 'https://youtu.be/dQw4w9WgXcQ',
    })));
    const p = await prisma.product.findUnique({
      where: { id: 'vitest-bat' },
      include: { tiers: { orderBy: { minQty: 'asc' } } },
    });
    expect(p.name).toBe('Vitest Bat');
    expect(p.sizes).toEqual(['SH', '6', '5']);
    expect(p.features).toEqual([{ label: 'Grade A willow', icon: 'check' }]);
    expect(p.stockQty).toBe(15);
    expect(p.barcode).toBe('7771110000099');
    expect(p.videoUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(p.tiers.map((t) => [t.minQty, Number(t.unitPrice)])).toEqual([[10, 180000], [50, 160000]]);
  });

  it('updates rather than duplicating when the sheet is sent again', async () => {
    await importProducts(sheet(row()));
    const again = await importProducts(sheet(row({ name: 'Renamed Bat' })));
    expect(again.created).toBe(0);
    expect(again.updated).toBe(1);
    expect(await prisma.product.count({ where: { id: 'vitest-bat' } })).toBe(1);
    expect((await prisma.product.findUnique({ where: { id: 'vitest-bat' } })).name).toBe('Renamed Bat');
  });

  it('records a price cut so it reaches the Deals shelf', async () => {
    await importProducts(sheet(row()));
    const cut = await importProducts(sheet(row({ tier1_price: '1500', tier2_price: '1350' })));
    expect(cut.priceDrops).toBe(1);

    const change = await prisma.priceChange.findFirst({
      where: { productId: 'vitest-bat' }, orderBy: { changedAt: 'desc' },
    });
    expect(Number(change.oldPrice)).toBe(180000);
    expect(Number(change.newPrice)).toBe(150000);
  });

  it('leaves stock untracked when the column is blank', async () => {
    await importProducts(sheet(row({ stockQty: '' })));
    expect((await prisma.product.findUnique({ where: { id: 'vitest-bat' } })).stockQty).toBeNull();
  });
});

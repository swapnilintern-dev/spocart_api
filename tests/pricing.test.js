import { describe, it, expect } from 'vitest';
import { priceFor, totals, validateTiers } from '../src/services/pricing.js';

const bat = [
  { minQty: 10, unitPrice: 180000n },
  { minQty: 50, unitPrice: 160000n },
  { minQty: 100, unitPrice: 140000n },
  { minQty: 500, unitPrice: 120000n },
];

describe('slab pricing', () => {
  it('drops across slabs', () => {
    expect(priceFor(bat, 10)).toBe(180000n);
    expect(priceFor(bat, 49)).toBe(180000n);
    expect(priceFor(bat, 50)).toBe(160000n);
    expect(priceFor(bat, 120)).toBe(140000n);
    expect(priceFor(bat, 500)).toBe(120000n);
  });

  it('applies 18% GST on the subtotal in paise', () => {
    const t = totals([{ unitPrice: 180000n, quantity: 10 }, { unitPrice: 35000n, quantity: 96 }]);
    expect(t.subtotal).toBe(5160000n);
    expect(t.gst).toBe(928800n);
    expect(t.total).toBe(6088800n);
  });

  it('rejects broken tier tables', () => {
    expect(validateTiers(bat, 10)).toBeNull();
    expect(validateTiers(bat, 5)).toMatch(/MOQ/);
    expect(validateTiers([bat[0], { minQty: 5, unitPrice: 1n }], 10)).toMatch(/increase/);
    expect(validateTiers([bat[0], { minQty: 50, unitPrice: 190000n }], 10)).toMatch(/decrease/);
  });
});

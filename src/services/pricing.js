// Pure pricing rules — no database, so they are unit-testable and shared by
// order placement, quotes and the admin tier editor.
export const GST_PERCENT = 18n;

/** Per-unit price for `qty` given ascending tiers [{ minQty, unitPrice }]. */
export function priceFor(tiers, qty) {
  let price = tiers[0].unitPrice;
  for (const t of tiers) if (qty >= t.minQty) price = t.unitPrice;
  return price;
}

/** Subtotal, GST and total in paise for priced lines [{ unitPrice, quantity }]. */
export function totals(lines) {
  const subtotal = lines.reduce((sum, l) => sum + BigInt(l.unitPrice) * BigInt(l.quantity), 0n);
  const gst = (subtotal * GST_PERCENT) / 100n;
  return { subtotal, gst, total: subtotal + gst };
}

/** Validates an admin-edited tier table: ascending quantities, descending prices, starts at MOQ. */
export function validateTiers(tiers, moq) {
  if (!tiers.length) return 'At least one price tier is required.';
  if (tiers[0].minQty !== moq) return `The first tier must start at the MOQ (${moq}).`;
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].minQty <= tiers[i - 1].minQty) return 'Tier quantities must increase.';
    if (BigInt(tiers[i].unitPrice) >= BigInt(tiers[i - 1].unitPrice)) return 'Tier prices must decrease as quantity grows.';
  }
  return null;
}

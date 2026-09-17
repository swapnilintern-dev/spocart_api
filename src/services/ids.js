// Human-readable ids: SC-2025-0345, INV-2025-0132, QT-2025-0871.
// One atomic upsert per id — gap-free per prefix per calendar year.
export async function nextId(tx, prefix) {
  const year = new Date().getFullYear();
  const rows = await tx.$queryRaw`
    INSERT INTO id_counters (prefix, year, seq) VALUES (${prefix}, ${year}, 1)
    ON CONFLICT (prefix, year) DO UPDATE SET seq = id_counters.seq + 1
    RETURNING seq`;
  return `${prefix}-${year}-${String(rows[0].seq).padStart(4, '0')}`;
}

-- The barcode printed on the box, so a buyer can scan a carton instead of
-- searching. Nullable: it stays empty until someone enters it, and a scan of an
-- unknown code says so rather than guessing.
ALTER TABLE "products" ADD COLUMN "barcode" TEXT;

-- Two products can never share a code, so a scan resolves to exactly one.
CREATE UNIQUE INDEX "products_barcode_key" ON "products"("barcode");

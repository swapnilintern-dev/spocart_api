-- AlterTable
ALTER TABLE "products" ADD COLUMN     "featured_rank" INTEGER;

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE INDEX "products_featured_rank_idx" ON "products"("featured_rank");

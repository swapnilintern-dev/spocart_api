-- CreateEnum
CREATE TYPE "PromotionAudience" AS ENUM ('all', 'registered', 'unregistered');

-- CreateEnum
CREATE TYPE "PromotionLinkType" AS ENUM ('none', 'product', 'category', 'url');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "stock_qty" INTEGER,
ADD COLUMN     "video_url" TEXT;

-- CreateTable
CREATE TABLE "price_changes" (
    "id" BIGSERIAL NOT NULL,
    "product_id" TEXT NOT NULL,
    "old_price" BIGINT NOT NULL,
    "new_price" BIGINT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "price_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "image_url" TEXT,
    "link_type" "PromotionLinkType" NOT NULL DEFAULT 'none',
    "link_target" TEXT,
    "audience" "PromotionAudience" NOT NULL DEFAULT 'all',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_changes_product_id_changed_at_idx" ON "price_changes"("product_id", "changed_at");

-- CreateIndex
CREATE INDEX "price_changes_changed_at_idx" ON "price_changes"("changed_at");

-- CreateIndex
CREATE INDEX "promotions_active_starts_at_ends_at_idx" ON "promotions"("active", "starts_at", "ends_at");

-- AddForeignKey
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What the app did, for active-user counts and the cart funnel.
--
-- Counts only. A row carries no free text a buyer typed: a search records how
-- long the query was and whether it matched, never the query itself. Money is
-- never read from here — sales always come from `orders`.

CREATE TYPE "UsageEventName" AS ENUM ('appOpen', 'productView', 'search', 'addToCart', 'checkoutStart', 'orderPlaced');

CREATE TABLE "usage_events" (
  "id" BIGSERIAL NOT NULL,
  "name" "UsageEventName" NOT NULL,
  "user_id" UUID,
  "device_id" TEXT NOT NULL,
  "platform" TEXT NOT NULL DEFAULT '',
  "product_id" TEXT,
  "order_id" TEXT,
  "meta" JSONB NOT NULL DEFAULT '{}',
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "day" CHAR(10) NOT NULL,
  CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "usage_events_day_name_idx" ON "usage_events"("day", "name");
CREATE INDEX "usage_events_name_at_idx" ON "usage_events"("name", "at");
CREATE INDEX "usage_events_user_id_day_idx" ON "usage_events"("user_id", "day");
CREATE INDEX "usage_events_device_id_day_idx" ON "usage_events"("device_id", "day");

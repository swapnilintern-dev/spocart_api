-- Rewards and credits.
--
-- Every rule starts at zero and `active` starts false: nothing is earned or
-- redeemed until the business sets real numbers in the admin panel. Both ways
-- of earning the CEO raised — a daily streak, and credits per rupee spent —
-- are supported so the decision stays a setting rather than a rewrite.

CREATE TYPE "CreditReason" AS ENUM ('orderEarned', 'orderReversed', 'dailyCheckIn', 'referral', 'redeemed', 'adminAdjust', 'expired');
CREATE TYPE "RewardMode" AS ENUM ('purchase', 'streak', 'both');
CREATE TYPE "RewardClaimStatus" AS ENUM ('earned', 'claimed', 'delivered');

CREATE TABLE "reward_settings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "mode" "RewardMode" NOT NULL DEFAULT 'purchase',
  "credits_per_100_rupees" INTEGER NOT NULL DEFAULT 0,
  "credit_paise_value" INTEGER NOT NULL DEFAULT 0,
  "daily_check_in_credits" INTEGER NOT NULL DEFAULT 0,
  "referral_credits" INTEGER NOT NULL DEFAULT 0,
  "max_redeem_percent" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reward_settings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "reward_settings" ADD CONSTRAINT "reward_settings_sane"
  CHECK ("credits_per_100_rupees" >= 0 AND "credit_paise_value" >= 0
     AND "daily_check_in_credits" >= 0 AND "referral_credits" >= 0
     AND "max_redeem_percent" BETWEEN 0 AND 100);

CREATE TABLE "credit_entries" (
  "id" BIGSERIAL NOT NULL,
  "user_id" UUID NOT NULL,
  "delta" INTEGER NOT NULL,
  "reason" "CreditReason" NOT NULL,
  "order_id" TEXT,
  "note" TEXT NOT NULL DEFAULT '',
  "event_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_entries_pkey" PRIMARY KEY ("id")
);

-- What an entry was for, exactly once: the same order or the same day's
-- check-in can never be awarded twice.
CREATE UNIQUE INDEX "credit_entries_event_key_key" ON "credit_entries"("event_key");
CREATE INDEX "credit_entries_user_id_created_at_idx" ON "credit_entries"("user_id", "created_at");

ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "reward_tiers" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "threshold" BIGINT NOT NULL,
  "gift_label" TEXT NOT NULL,
  "image_url" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reward_tiers_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "reward_tiers" ADD CONSTRAINT "reward_tier_threshold_positive" CHECK ("threshold" > 0);
CREATE INDEX "reward_tiers_threshold_idx" ON "reward_tiers"("threshold");

CREATE TABLE "reward_claims" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "tier_id" UUID NOT NULL,
  "status" "RewardClaimStatus" NOT NULL DEFAULT 'earned',
  "total_at_claim" BIGINT NOT NULL,
  "admin_note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reward_claims_pkey" PRIMARY KEY ("id")
);

-- One buyer reaches one tier once, however often the screen is refreshed.
CREATE UNIQUE INDEX "reward_claims_user_id_tier_id_key" ON "reward_claims"("user_id", "tier_id");
CREATE INDEX "reward_claims_status_created_at_idx" ON "reward_claims"("status", "created_at");

ALTER TABLE "reward_claims" ADD CONSTRAINT "reward_claims_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reward_claims" ADD CONSTRAINT "reward_claims_tier_id_fkey"
  FOREIGN KEY ("tier_id") REFERENCES "reward_tiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The rules row exists from the start, switched off.
INSERT INTO "reward_settings" ("id", "updated_at") VALUES ('default', CURRENT_TIMESTAMP);

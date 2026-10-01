-- An OTP is bound to what it was sent for, so a sign-in code cannot be used to
-- move an account to a new number. Existing rows are sign-in codes.
CREATE TYPE "OtpPurpose" AS ENUM ('login', 'mobileChange');

ALTER TABLE "otp_codes"
  ADD COLUMN "purpose" "OtpPurpose" NOT NULL DEFAULT 'login',
  ADD COLUMN "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "otp_codes" DROP CONSTRAINT "otp_codes_pkey";
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("mobile", "purpose");

-- India Post PIN lookups, cached so the address form stays fast and still works
-- for known PINs when the upstream service is unavailable.
CREATE TABLE "pincodes" (
  "pincode" CHAR(6) NOT NULL,
  "city" TEXT NOT NULL,
  "district" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pincodes_pkey" PRIMARY KEY ("pincode")
);

ALTER TABLE "pincodes" ADD CONSTRAINT "pincode_is_six_digits" CHECK ("pincode" ~ '^[1-9][0-9]{5}$');

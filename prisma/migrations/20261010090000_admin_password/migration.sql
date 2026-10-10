-- Admins sign in with a password AND an OTP; buyers keep OTP alone.
--
-- Nullable because only admins ever have one. A buyer row with a password hash
-- would be meaningless, and a NOT NULL column would force a fake value onto
-- every existing customer.
ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;

-- The admin's second factor needs its own purpose: the purpose is part of the
-- OTP hash as well as its key, so a code issued to sign a buyer in can never
-- be replayed against the admin login.
ALTER TYPE "OtpPurpose" ADD VALUE 'adminLogin';

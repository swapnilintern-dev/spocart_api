-- Account deletion keeps the user row so its orders and GST invoices still
-- join, but replaces the mobile with one that can never be dialled or
-- registered again: a leading zero, which no Indian mobile carries. That frees
-- the real number for a fresh account.
--
-- The format check was written before deletion existed and only allowed live
-- numbers, so it has to admit the retired form as well.
ALTER TABLE users DROP CONSTRAINT users_mobile_format;

ALTER TABLE users ADD CONSTRAINT users_mobile_format
  CHECK (mobile ~ '^[6-9][0-9]{9}$' OR mobile ~ '^0[0-9]{9}$');

-- One default address per buyer (partial unique index).
CREATE UNIQUE INDEX one_default_address ON addresses (user_id) WHERE is_default;

-- Data rules the app relies on.
ALTER TABLE users ADD CONSTRAINT users_mobile_format CHECK (mobile ~ '^[6-9][0-9]{9}$');
ALTER TABLE addresses ADD CONSTRAINT addresses_pincode_format CHECK (pincode ~ '^[1-9][0-9]{5}$');
ALTER TABLE products ADD CONSTRAINT products_moq_positive CHECK (moq > 0);
ALTER TABLE product_tiers ADD CONSTRAINT product_tiers_price_positive CHECK (unit_price > 0);
ALTER TABLE orders ADD CONSTRAINT orders_totals_consistent CHECK (total = subtotal + gst AND subtotal >= 0);

-- Website search on name / brand.
CREATE INDEX products_search_idx ON products USING GIN (to_tsvector('simple', name || ' ' || brand || ' ' || subcategory));

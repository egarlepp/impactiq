-- v1.93.0: allow admins to upload a small icon for each product so
-- product pills across the app can render "logo + label" instead of
-- text-only pills. Stored inline as a data URL (PNG / SVG / BMP,
-- capped at 1 MB decoded). Kept in the products table so a single
-- SELECT returns the icon with the rest of the row — no separate
-- attachment table for a max-1MB blob.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS icon_data_url text;

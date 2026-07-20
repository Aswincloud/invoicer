-- Optional business logo shown at the top of the invoice (preview + PDF).
-- Stored as a downscaled data-URL string on the user's profile.
ALTER TABLE users ADD COLUMN biz_logo TEXT DEFAULT '';

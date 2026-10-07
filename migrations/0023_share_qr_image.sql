-- A Razorpay UPI QR shown on the public invoice page (2026-10-07).
--
-- Razorpay's QR Codes API answers with an image link (image_url) and no
-- upi:// string, which is why /u/<token> stopped minting them (0021, 29 Sep).
-- On /i/<token> an image is the point: the customer scans it with any UPI app,
-- and the qr_code.credited webhook marks the invoice PAID. The image link is
-- kept so every view of the page shows the same QR instead of minting another.
--
--   rzp_qr_image   Razorpay's image_url for the QR in rzp_qr_id
ALTER TABLE invoices ADD COLUMN rzp_qr_image TEXT;

-- Pay-by-UPI for an unpaid invoice, from a WhatsApp button (2026-09-29).
--
-- The "Pay by UPI" button opens /u/<share_token>, which hands the phone a
-- upi://pay link so Android shows its UPI app chooser. Preferably that link is a
-- Razorpay single-use UPI QR for the exact amount: Razorpay then tells us via
-- the qr_code.credited webhook, and the invoice turns PAID on its own. The QR is
-- created on first open and reused while the amount matches and it is open:
--
--   rzp_qr_id        Razorpay's qr_… id; the webhook finds the invoice by it
--   rzp_qr_upi       the upi://pay string behind the QR, exactly as issued
--   rzp_qr_amount    paise the QR is fixed to; a changed total mints a new one
--   rzp_qr_close_by  epoch ms Razorpay closes it; a near-expired one is replaced
--   paid_via         'checkout' | 'upi_qr' | null — how it was settled
--
-- The payment-request message is recorded apart from the paid confirmation,
-- or sending the request would stop the receipt going out once it is paid:
--
--   wa_request_message_id / wa_request_at
ALTER TABLE invoices ADD COLUMN rzp_qr_id TEXT;
ALTER TABLE invoices ADD COLUMN rzp_qr_upi TEXT;
ALTER TABLE invoices ADD COLUMN rzp_qr_amount INTEGER;
ALTER TABLE invoices ADD COLUMN rzp_qr_close_by INTEGER;
ALTER TABLE invoices ADD COLUMN paid_via TEXT;
ALTER TABLE invoices ADD COLUMN wa_request_message_id TEXT;
ALTER TABLE invoices ADD COLUMN wa_request_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_rzp_qr ON invoices(rzp_qr_id) WHERE rzp_qr_id IS NOT NULL;

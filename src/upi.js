// The UPI address behind the "scan to pay" QR.
//
// Small, and deliberately strict. Everything here exists to make one failure
// impossible: a QR that names the wrong payee. A customer scanning a receipt
// trusts whatever the code says, so an address this module is not certain about
// produces NO URI, and therefore no QR — the receipt falls back to the pay-to
// text it prints today. Failing closed costs a convenience; failing open costs
// somebody else's money.

/* Is this a Virtual Payment Address?
   
   Shape is `handle@psp` — "6380157944@yescred", "aswin.z@okhdfcbank". Checked
   rather than trusted because the value is typed by hand and, once it is in a
   QR, nobody reads it again.

   Rejects, specifically:
     * anything with whitespace — "GPay - 6380157944" and friends
     * more than one "@"
     * a PSP containing a dot — that is an email domain, not a UPI handle, and
       "someone@example.com" is the single most likely wrong thing to paste here
     * a PSP that does not start with a letter */
export function isVpa(s) {
  const v = String(s || "").trim();
  if (!v || /\s/.test(v)) return false;
  if ((v.match(/@/g) || []).length !== 1) return false;

  const [handle, psp] = v.split("@");
  if (!/^[\w.\-]{2,64}$/.test(handle)) return false;
  // No dots: an email domain always has one, a UPI PSP never does.
  if (!/^[a-zA-Z][\w\-]{1,32}$/.test(psp)) return false;
  return true;
}

/* The URI a static pay QR encodes, or "" when the address is not usable.

   No `am`: this is a static QR by choice, so the customer enters the amount.
   Adding `&am=<total>&tn=<invoice number>` here is all it would take to make it
   amount-bearing and reconcilable, if typing the figure proves annoying.

   `pn` is URL-encoded. A business called "Smith & Sons" would otherwise end the
   query string early and the payee name would arrive truncated. */
export function upiPayUri(vpa, payeeName) {
  if (!isVpa(vpa)) return "";
  const pn = encodeURIComponent(String(payeeName || "").trim() || "Payment");
  return `upi://pay?pa=${String(vpa).trim()}&pn=${pn}&cu=INR`;
}

/* ── an existing provider's QR, kept exactly as issued ───────────────────────

   A Razorpay static QR decodes to more than an address:

     upi://pay?cu=INR&mc=5262&mode=19&pa=aswincloud860450.rzp@rxairtel
              &tn=Payment%20To%20Aswincloud&tr=TNjWlQSmcSddNNqrv2

   `tr` is the provider's reference for that specific QR, and `mc`/`mode`
   describe the merchant and the QR's type. Rebuilding the URI from `pa` alone
   throws all of that away and produces a different QR — one the provider never
   issued. Whether they would attribute a payment to it identically is not
   knowable from here, so the payload is stored and re-encoded byte for byte. */

/* Does this look like a payment QR's contents?

   Accepts a UPI intent URI, and an EMV/Bharat QR payload (those begin with the
   EMVCo payload-format indicator "000201"), so a bank or Paytm QR works without
   further code. Anything else is refused rather than encoded hopefully: a QR
   built from a random string is a QR that fails in a customer's hand. */
export function isPayQrPayload(s) {
  const v = String(s || "").trim();
  if (!v || v.length > 1200 || /[\r\n]/.test(v)) return false;
  if (/^upi:\/\/pay\?/i.test(v)) return /[?&]pa=[^&\s]+/.test(v);
  return /^000201/.test(v);                    // EMVCo payload format indicator
}

/* What a business's pay QR should encode.

   A pasted payload wins over a typed address: it is the thing the provider
   actually issued, and the typed address can only ever be a reconstruction. */
export function payQrText(biz) {
  const raw = String((biz && (biz.pay_qr ?? biz.payQr)) || "").trim();
  if (isPayQrPayload(raw)) return raw;
  return upiPayUri(biz && (biz.upi_vpa ?? biz.upiVpa), biz && (biz.biz_name ?? biz.bizName));
}

/* The payee address inside a payload, for printing beside the QR so a human can
   read who they are about to pay. "" when there is nothing to show — an EMV
   payload keeps the address in a nested TLV this does not parse. */
export function payeeFromPayload(text) {
  const m = /[?&]pa=([^&\s]+)/.exec(String(text || ""));
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

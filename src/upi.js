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

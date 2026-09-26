// The pay-me form. Validation is the part a stranger can throw anything at, so
// it is pinned exhaustively; the invoice-from-order path is pinned for the
// property that matters most - the stored amount is Razorpay's, not the form's.
import { validatePayForm, isPayLinkOrder, paylinkEnabled, PAYLINK_SOURCE } from "../src/paylink.js";
let failed = 0;
const check = (l, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`); if (!c) failed++; };
const env = { PAYLINK_MIN: "10", PAYLINK_MAX: "50000" };
const good = { name: "Priya R", phone: "98765 43210", what: "Custom keychain x2", amount: "350",
               address: "12, 2nd Cross, Anna Nagar\nPondicherry 605005" };

console.log("— accepts what a person types —");
let v = validatePayForm(env, good);
check("valid form passes", v.ok, JSON.stringify(v));
check("phone normalised to E.164", v.phone === "919876543210", v.phone);
check("amount in whole paise", v.amountPaise === 35000, String(v.amountPaise));
check("₹ and commas tolerated", validatePayForm(env, { ...good, amount: "₹1,250" }).amountPaise === 125000);
check("decimals rounded to paise", validatePayForm(env, { ...good, amount: "99.995" }).amountPaise === 10000);
check("optional email accepted", validatePayForm(env, { ...good, email: "p@example.com" }).email === "p@example.com");
check("whitespace collapsed in name", validatePayForm(env, { ...good, name: "  Priya   R " }).name === "Priya R");
check("address keeps its line breaks", validatePayForm(env, good).address === "12, 2nd Cross, Anna Nagar\nPondicherry 605005");
check("address: CRLF, runs of spaces and blank lines normalised",
  validatePayForm(env, { ...good, address: "  12,  Anna   Nagar  \r\n\r\n Pondicherry  605005 \n" }).address === "12, Anna Nagar\nPondicherry 605005",
  JSON.stringify(validatePayForm(env, { ...good, address: "  12,  Anna   Nagar  \r\n\r\n Pondicherry  605005 \n" }).address));
check("address clamped to Razorpay's note limit", validatePayForm(env, { ...good, address: "x".repeat(400) }).address.length === 250);

console.log("\n— refuses what it must —");
check("no name", !validatePayForm(env, { ...good, name: "" }).ok);
check("one-letter name", !validatePayForm(env, { ...good, name: "P" }).ok);
check("bad phone", !validatePayForm(env, { ...good, phone: "12345" }).ok);
check("no phone", !validatePayForm(env, { ...good, phone: "" }).ok);
check("no 'what'", !validatePayForm(env, { ...good, what: "" }).ok);
check("no address", !validatePayForm(env, { ...good, address: "" }).ok);
check("address too short to be one", !validatePayForm(env, { ...good, address: "Chennai" }).ok);
check("address error mentions the PIN code", /PIN/.test(validatePayForm(env, { ...good, address: "" }).error));
check("zero amount", !validatePayForm(env, { ...good, amount: "0" }).ok);
check("negative amount", !validatePayForm(env, { ...good, amount: "-50" }).ok);
check("non-numeric amount", !validatePayForm(env, { ...good, amount: "fifty" }).ok);
check("below the floor (₹9)", !validatePayForm(env, { ...good, amount: "9" }).ok);
check("above the ceiling (₹50,001)", !validatePayForm(env, { ...good, amount: "50001" }).ok);
check("ceiling message says to ask for an invoice", /invoice/i.test(validatePayForm(env, { ...good, amount: "99999" }).error));
check("malformed email", !validatePayForm(env, { ...good, email: "not-an-email" }).ok);
check("null body", !validatePayForm(env, null).ok);
check("fields clamped, not rejected, when long", validatePayForm(env, { ...good, what: "x".repeat(500) }).what.length === 160);

console.log("\n— bounds come from config —");
check("custom floor", !validatePayForm({ PAYLINK_MIN: "100" }, { ...good, amount: "50" }).ok);
check("custom ceiling", validatePayForm({ PAYLINK_MAX: "1000" }, { ...good, amount: "1000" }).ok && !validatePayForm({ PAYLINK_MAX: "1000" }, { ...good, amount: "1001" }).ok);
check("defaults when unset: 10..50000", validatePayForm({}, { ...good, amount: "10" }).ok && !validatePayForm({}, { ...good, amount: "9" }).ok && !validatePayForm({}, { ...good, amount: "50001" }).ok);

console.log("\n— only OUR orders become invoices —");
check("order with the note is ours", isPayLinkOrder({ notes: { invoicer_paylink: "1" } }));
check("shop order is not", !isPayLinkOrder({ notes: { source: "shop" } }));
check("no notes is not", !isPayLinkOrder({}) && !isPayLinkOrder(null));
check("note must be exactly '1'", !isPayLinkOrder({ notes: { invoicer_paylink: "yes" } }));
check("source constant", PAYLINK_SOURCE === "paylink");

console.log("\n— enabled only when payments are —");
const cfg = { PAY_ENABLED: "true", RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s" };
check("on", paylinkEnabled(cfg));
check("PAY_ENABLED=false turns it off", !paylinkEnabled({ ...cfg, PAY_ENABLED: "false" }));
check("PAYLINK_ENABLED=false turns it off alone", !paylinkEnabled({ ...cfg, PAYLINK_ENABLED: "false" }));
check("no Razorpay keys turns it off", !paylinkEnabled({ PAY_ENABLED: "true" }));

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);

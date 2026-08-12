// Amount in words, dates, and place of supply.
//
// Words on an invoice are the check against a figure being altered after issue,
// so getting the Indian grouping right matters: 1234567 is "Twelve Lakh Thirty
// Four Thousand...", never "One Million...".

import { numberToWords, amountInWords, fmtDate, placeOfSupply } from "../src/invoice-html.js";

let failed = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); failed++; }
};

console.log("— Indian grouping —");
eq("0", numberToWords(0), "Zero");
eq("7", numberToWords(7), "Seven");
eq("15 (teen)", numberToWords(15), "Fifteen");
eq("40", numberToWords(40), "Forty");
eq("68", numberToWords(68), "Sixty Eight");
eq("100", numberToWords(100), "One Hundred");
eq("6868", numberToWords(6868), "Six Thousand Eight Hundred Sixty Eight");
eq("100000 is a lakh", numberToWords(100000), "One Lakh");
eq("1234567 uses lakh, not million", numberToWords(1234567),
  "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven");
eq("10000000 is a crore", numberToWords(10000000), "One Crore");
eq("crore above 999 recurses", numberToWords(12000000000),
  "One Thousand Two Hundred Crore");

console.log("\n— the invoice line —");
eq("whole rupees", amountInWords(6868, "₹"),
  "Rupees Six Thousand Eight Hundred Sixty Eight Only");
eq("with paise", amountInWords(6867.6, "₹"),
  "Rupees Six Thousand Eight Hundred Sixty Seven and Sixty Paise Only");
eq("half a paisa does not become Zero Paise", amountInWords(500.004, "₹"),
  "Rupees Five Hundred Only");
eq("rounds paise properly", amountInWords(99.999, "₹"),
  "Rupees One Hundred Only");
eq("non-₹ gets nothing", amountInWords(500, "$"), "");
eq("negative", amountInWords(-50, "₹"), "Minus Rupees Fifty Only");

console.log("\n— dates —");
eq("stored ISO date", fmtDate("2026-08-12"), "12 Aug 2026");
eq("single-digit day loses its zero", fmtDate("2026-01-05"), "5 Jan 2026");
eq("epoch ms", fmtDate(Date.UTC(2026, 7, 11, 8, 29)), "11 Aug 2026");
eq("empty stays empty", fmtDate(""), "");
eq("null stays empty", fmtDate(null), "");
// The trap: new Date("2026-08-12") is UTC midnight, so a local-time format
// prints the 11th anywhere west of Greenwich. Must not depend on the zone.
const beforeTZ = process.env.TZ;
process.env.TZ = "America/Los_Angeles";
eq("no timezone shift on a stored date", fmtDate("2026-08-12"), "12 Aug 2026");
process.env.TZ = beforeTZ;

console.log("\n— place of supply —");
eq("Karnataka", placeOfSupply({ client_gst: "29AABCU9603R1ZM" }), "Karnataka (29)");
eq("Puducherry", placeOfSupply({ client_gst: "34ABCDE1234F1Z9" }), "Puducherry (34)");
eq("leading-zero state code", placeOfSupply({ client_gst: "07AAACX1234A1Z5" }), "Delhi (07)");
eq("no GSTIN invents nothing", placeOfSupply({ client_gst: "" }), "");
eq("junk invents nothing", placeOfSupply({ client_gst: "not-a-gstin" }), "");
eq("unknown code invents nothing", placeOfSupply({ client_gst: "99AAAAA0000A1Z5" }), "");

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);

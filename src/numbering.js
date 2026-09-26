// Invoice numbers: PREFIX-YEAR-<4 digits>, unused by this account.
//
// The alternative, sequential numbering, tells a customer how many invoices you
// have issued — so the serial is random. But 4 digits is 9000 slots, and picking
// blind gave a 43% chance of a collision within 100 invoices: production once
// had two entirely unrelated invoices sharing INV-AC-2026-2257 (Rs 350 paid, and
// Rs 25,000 unpaid). Checking against the account's numbers here makes a
// collision unlikely; the unique index in migration 0009 makes it impossible,
// and callers that insert without a person watching retry on that error.
//
// Drawn from here by the dashboard (GET /api/invoices/next-number) and by the
// /pay webhook (invoiceFromPaidOrder), so a receipt born from a payment is
// indistinguishable from an invoice raised by hand.
import { now } from "./lib.js";

export const cleanPrefix = (p) => String(p || "INV").replace(/[^\w-]/g, "").slice(0, 20) || "INV";

// Null when 40 blind draws all hit used numbers: the 9000-number space is
// genuinely crowded for this year, and the caller should say so.
export async function freeInvoiceNumber(env, userId, prefix) {
  const pre = cleanPrefix(prefix);
  const year = new Date(now()).getUTCFullYear();
  const { results } = await env.DB.prepare(
    "SELECT number FROM invoices WHERE user_id=? AND status <> 'VOID'"
  ).bind(userId).all();
  const used = new Set((results || []).map((r) => r.number));
  for (let i = 0; i < 40; i++) {
    const n = `${pre}-${year}-${Math.floor(Math.random() * 9000) + 1000}`;
    if (!used.has(n)) return n;
  }
  return null;
}

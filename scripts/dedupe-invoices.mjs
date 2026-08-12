#!/usr/bin/env node
/* Void the duplicate invoices that Save-always-creates left behind.
 *
 *   node scripts/dedupe-invoices.mjs            # report only (default)
 *   node scripts/dedupe-invoices.mjs --apply    # write
 *   node scripts/dedupe-invoices.mjs --local    # against the local D1
 *
 * ── Why this is a script and not a migration ────────────────────────────────
 *
 * Migration 0009 adds a unique index on (user_id, number) for non-VOID rows. It
 * CANNOT be applied while duplicates exist, and resolving them needs judgement
 * a migration has no way to exercise: some of these rows are the same invoice
 * saved repeatedly, and some are different invoices that collided on a random
 * number. Voiding the wrong one destroys a real document.
 *
 * ── It voids, it never deletes ──────────────────────────────────────────────
 *
 * These are financial records. A superseded copy still says something true —
 * that this document existed and was replaced — and the partial index keeps
 * VOID rows legal so nothing has to be destroyed to satisfy it.
 *
 * ── It refuses to guess ─────────────────────────────────────────────────────
 *
 * A group is only auto-resolved when the copies are plainly the same invoice:
 * one client, at most one row carrying a payment or a live share link, and no
 * disagreement between rows that claim to have been PAID. Anything else is
 * printed for a human. In production that means:
 *
 *   INV-AC-2026-2999  three rows all marked PAID at 600, 600 and 550 — which
 *                     figure was actually settled is a question about money.
 *   INV-AC-2026-2257  Rs 350 for Monisha (paid) and Rs 25,000 for nobody
 *                     (unpaid) — two different invoices sharing one number.
 *                     One needs RENUMBERING, not voiding.
 */

import { execFileSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");
const LOCAL = process.argv.includes("--local");
const SCOPE = LOCAL ? "--local" : "--remote";

function sql(query) {
  const out = execFileSync("npx", [
    "wrangler", "d1", "execute", "invoicer-db", SCOPE, "--json", "--command", query,
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out)[0].results;
}

const money = (n) => Number(n).toFixed(2).padStart(10);
const when = (ms) => new Date(Number(ms)).toISOString().slice(0, 16).replace("T", " ");

const rows = sql(`
  SELECT id, user_id, number, status, total, client_name, created_at,
         (rzp_payment_id IS NOT NULL) AS paid_online,
         (share_token IS NOT NULL) AS shared, source
    FROM invoices
   WHERE (user_id, number) IN (
           SELECT user_id, number FROM invoices
            WHERE status <> 'VOID'
            GROUP BY user_id, number HAVING COUNT(*) > 1)
     AND status <> 'VOID'
   ORDER BY user_id, number, created_at`);

if (!rows.length) {
  console.log("No duplicated invoice numbers. Migration 0009 can be applied.");
  process.exit(0);
}

const groups = new Map();
for (const r of rows) {
  const key = `${r.user_id}|${r.number}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const toVoid = [];
const needsAHuman = [];

for (const [key, g] of groups) {
  const number = key.split("|")[1];
  const clients = new Set(g.map((r) => (r.client_name || "").trim().toLowerCase()));
  const encumbered = g.filter((r) => r.paid_online || r.shared).length;

  /* Several rows marked PAID are only safely mechanical when they agree on the
     amount. Identical figures mean one invoice saved twice; DIFFERENT figures
     mean somebody edited the price and every version still claims to have been
     settled — and picking which one was really paid is a question about money,
     not about rows. (Production: 2999 is 600, 600 and 550.) */
  const paidTotals = new Set(
    g.filter((r) => String(r.status).toUpperCase() === "PAID")
     .map((r) => Number(r.total).toFixed(2)));
  const paidDisagree = paidTotals.size > 1;

  // Same client, at most one row carrying a payment or a live link, and no
  // disagreement about what was paid.
  const mechanical = clients.size === 1 && encumbered <= 1 && !paidDisagree;

  console.log(`\n${number}${mechanical ? "" : "   ← needs a decision"}`);
  for (const r of g) {
    const flags = [r.paid_online ? "razorpay" : "", r.shared ? "shared-link" : "",
                   r.source ? r.source : ""].filter(Boolean).join(" ");
    console.log(`   ${r.status.padEnd(7)} ${money(r.total)}  ` +
                `${(r.client_name || "—").slice(0, 20).padEnd(20)} ${when(r.created_at)}  ${flags}`);
  }

  if (!mechanical) {
    needsAHuman.push({ number, rows: g,
      why: clients.size > 1
             ? "different clients — these look like two real invoices sharing a number"
             : paidDisagree
               ? `several rows say PAID at different amounts (${[...paidTotals].join(", ")}) — which was settled?`
               : "more than one row carries a payment or a live share link" });
    continue;
  }

  const keep = g[g.length - 1];            // newest by created_at
  for (const r of g) if (r.id !== keep.id) toVoid.push({ ...r, number });
  console.log(`   → keep ${when(keep.created_at)}, void ${g.length - 1} superseded`);
}

console.log("\n" + "─".repeat(72));
console.log(`${groups.size} duplicated numbers, ${rows.length} rows.`);
console.log(`${toVoid.length} would be VOIDED; ${needsAHuman.length} group(s) left alone.`);

if (needsAHuman.length) {
  console.log("\nLeft for you to decide:");
  for (const g of needsAHuman) {
    console.log(`  ${g.number} — ${g.why}`);
  }
  console.log("\n  Voiding is the wrong tool for a number collision: renumber one of them\n" +
              "  instead (open it, change the number, Save). Re-run afterwards.");
}

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write. Back up first:");
  console.log("  npx wrangler d1 export invoicer-db --remote --output=backup.sql");
  process.exit(0);
}

for (const r of toVoid) {
  sql(`UPDATE invoices SET status='VOID', updated_at=${Date.now()} WHERE id='${r.id}'`);
  console.log(`voided ${r.number}  ${when(r.created_at)}  ${money(r.total)}`);
}

const left = sql(`SELECT COUNT(*) AS n FROM (
  SELECT user_id, number FROM invoices WHERE status <> 'VOID'
   GROUP BY user_id, number HAVING COUNT(*) > 1)`)[0].n;
console.log(`\nDone. ${left} duplicated number(s) remain.`);
console.log(left ? "Resolve those, then apply migration 0009."
                 : "Migration 0009 can now be applied.");

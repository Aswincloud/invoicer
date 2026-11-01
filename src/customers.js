// Saved customers (migration 0027): pick a returning customer instead of
// retyping their name, mobile, email, address and GSTIN.
//
// One row per customer per account, keyed by mobile when there is one, else by
// name. Every invoice save upserts it with the details on that invoice, so the
// list always holds what the customer most recently gave. Nothing is ever
// copied INTO an invoice without the owner picking it.
import { json, bad, now, uid } from "./lib.js";

export function customerKey(name, phone) {
  if (phone) return "p:" + phone;
  const n = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  return n ? "n:" + n : "";
}

/* Called after an invoice is saved. `inv` is invoiceFields(): client_phone is
   already E.164 or "". A blank field on the new invoice does not erase what
   the customer gave before; a filled one replaces it. Never throws — a failed
   upsert must not fail the save. */
export async function rememberCustomer(env, userId, inv, { isNew = true } = {}) {
  try {
    const name = String(inv.client_name || "").trim();
    const phone = String(inv.client_phone || "");
    const key = customerKey(name, phone);
    if (!key || !name || String(inv.status || "").toUpperCase() === "VOID") return;
    const t = now();
    await env.DB.prepare(
      `INSERT INTO customers (id,user_id,ckey,name,phone,email,addr,gst,invoices,last_used,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, ckey) DO UPDATE SET
         name = excluded.name,
         email = CASE WHEN excluded.email<>'' THEN excluded.email ELSE customers.email END,
         addr  = CASE WHEN excluded.addr<>''  THEN excluded.addr  ELSE customers.addr  END,
         gst   = CASE WHEN excluded.gst<>''   THEN excluded.gst   ELSE customers.gst   END,
         -- An edit re-saves the same invoice: counted on creation only.
         invoices = customers.invoices + excluded.invoices,
         last_used = excluded.last_used, updated_at = excluded.updated_at`
    ).bind(uid(), userId, key, name.slice(0, 120), phone,
           String(inv.client_email || "").slice(0, 160), String(inv.client_addr || "").slice(0, 500),
           String(inv.client_gst || "").slice(0, 20), isNew ? 1 : 0, t, t, t).run();
  } catch (e) {
    console.error("remember customer failed", String(e?.message || e));
  }
}

/* GET /api/customers?q= — the owner's customers matching q by name, mobile or
   email, most recently used first. Empty q lists the most recent. Scoped to
   the signed-in account; at most 12 rows, it feeds a dropdown. */
export async function searchCustomers(env, user, url) {
  const raw = String(url.searchParams.get("q") || "").trim().slice(0, 60);
  const digits = raw.replace(/\D/g, "");
  const like = "%" + raw.toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const { results } = await env.DB.prepare(
    `SELECT id, name, phone, email, addr, gst, invoices, last_used FROM customers
      WHERE user_id = ?
        AND (? = '' OR lower(name) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'
             OR (? <> '' AND phone LIKE ?))
      ORDER BY last_used DESC LIMIT 12`
  ).bind(user.id, raw, like, like, digits.length >= 3 ? digits : "", "%" + digits + "%").all();
  return json({ customers: results || [] });
}

/* DELETE /api/customers/:id — forget a saved customer (a typo, a one-off).
   Their invoices are untouched; the next invoice to them recreates the row. */
export async function deleteCustomer(env, user, id) {
  const r = await env.DB.prepare("DELETE FROM customers WHERE id=? AND user_id=?").bind(id, user.id).run();
  return r.meta?.changes ? json({ ok: true }) : bad("not found", 404);
}

// The UPI reference an owner types in for an invoice paid directly.
//
// Payment apps show it under different names — UTR, UPI Ref No., UPI
// transaction ID — usually 12 digits, sometimes letters too, sometimes with
// spaces or dashes for readability. Stored normalised: spaces and dashes
// dropped, uppercased, letters and digits only, 6 to 35 characters. Mirrored by
// cleanUpiRef() in public/js/core.js so the form rejects what the server would.
//
// Returns { ok, ref } — ref "" means "no reference" (clears it) — or
// { ok: false, error }.
import { json, bad, now } from "./lib.js";

export function cleanUpiRef(raw) {
  const ref = String(raw ?? "").replace(/[\s-]+/g, "").toUpperCase();
  if (!ref) return { ok: true, ref: "" };
  if (!/^[A-Z0-9]{6,35}$/.test(ref))
    return { ok: false, error: "A UPI reference is 6 to 35 letters and digits, like the 12-digit UTR in your payment app." };
  return { ok: true, ref };
}

/* POST /api/invoices/:id/upi-ref — add or correct the UPI reference on an
   invoice that is already PAID, which the edit lock otherwise freezes.

   Narrow on purpose: it touches upi_ref and nothing else, so it cannot move the
   total or rewrite the document the customer paid against. Refused on an
   invoice Razorpay settled — that one already has Razorpay's own reference,
   and a hand-typed one beside it could only contradict it. An empty ref clears
   a mistyped one. */
export async function setUpiRef(env, user, id, b) {
  const inv = await env.DB.prepare(
    "SELECT id, status, rzp_payment_id FROM invoices WHERE id=? AND user_id=?"
  ).bind(id, user.id).first();
  if (!inv) return bad("not found", 404);
  if (String(inv.status || "").toUpperCase() !== "PAID")
    return bad("Mark the invoice PAID first; a UPI reference belongs to a payment.", 409);
  if (inv.rzp_payment_id)
    return bad("This invoice was paid through Razorpay and already carries its reference.", 409);
  const upi = cleanUpiRef(b?.upiRef);
  if (!upi.ok) return bad(upi.error, 400);
  await env.DB.prepare(
    `UPDATE invoices SET upi_ref=?, paid_via=CASE WHEN ?='' THEN (CASE WHEN paid_via='upi_manual' THEN NULL ELSE paid_via END)
       ELSE COALESCE(paid_via,'upi_manual') END, updated_at=? WHERE id=? AND user_id=?`
  ).bind(upi.ref || null, upi.ref, now(), id, user.id).run();
  return json({ ok: true, upiRef: upi.ref });
}

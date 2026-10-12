// Tell the shop that a shop order shipped or was delivered — the invoicer's half
// of the two-way shipment sync (2026-10-12).
//
// The shop has always told the invoicer (POST /api/ingest/shipment). This is the
// reverse, for when Aswin ships or delivers from THIS dashboard: without it the
// shop order stays at "ready" while the customer already has a tracking
// WhatsApp, and shipping it there later looks like it would notify them again.
//
// Called the moment the dashboard records the change — no polling, no cron.
// Only for invoices that came from the shop (source='shop'), and only after the
// local record is written, so a slow or failing shop never blocks the dashboard.
// The shop moves the order along its own legal transitions, sends ITS email, and
// does not call back. Signed with the shared SHOP_INGEST_SECRET, under a prefix
// so a body the shop signed for us can never be replayed at the shop.
import { now, hmacHex, baseUrl } from "./lib.js";
import { carrierName } from "./shipment.js";

export async function notifyShopShipment(env, inv, kind) {
  if (String(inv?.source || "") !== "shop" || !inv.source_ref) return { ok: true, skipped: "not a shop order" };
  const url = baseUrl(env.SHOP_URL, "https://3d-prints.aswincloud.com");
  const secret = env.SHOP_INGEST_SECRET;
  if (!secret || String(env.SHOP_SYNC_ENABLED ?? "true").toLowerCase() === "false") {
    return { ok: true, skipped: "sync off" };
  }
  const raw = JSON.stringify({
    ts: now(), receipt: inv.source_ref, kind,
    // The shop's dashboard shows couriers by name; the invoicer stores an id.
    courier: carrierName(inv.courier) || String(inv.courier || ""),
    tracking: String(inv.tracking_id || ""),
  });
  try {
    const res = await fetch(`${url}/api/sync/shipment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "invoicer/1.0",
                 "x-invoicer-signature": await hmacHex("invoicer->shop\n" + raw, secret) },
      body: raw,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) console.error("shop shipment sync", kind, inv.source_ref, res.status, JSON.stringify(body).slice(0, 160));
    else console.log("shop shipment sync", kind, inv.source_ref, body.already ? "already" : body.status, body.emailed ? "emailed" : "");
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    console.error("shop shipment sync error", kind, inv.source_ref, e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

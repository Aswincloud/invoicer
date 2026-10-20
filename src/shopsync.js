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

const ATTEMPT_MS = 4000;

export async function notifyShopShipment(env, inv, kind) {
  if (String(inv?.source || "") !== "shop" || !inv.source_ref) return { ok: true, skipped: "not a shop order" };
  const url = baseUrl(env.SHOP_URL, "https://3d-prints.aswincloud.com");
  const secret = env.SHOP_INGEST_SECRET;
  if (!secret || String(env.SHOP_SYNC_ENABLED ?? "true").toLowerCase() === "false") {
    return { ok: true, skipped: "sync off" };
  }
  // HTTPS only: the request carries a signature and the customer's tracking.
  if (!/^https:\/\//i.test(url)) {
    console.error("shop shipment sync: SHOP_URL must be https — refusing", url.slice(0, 40));
    return { ok: false, error: "SHOP_URL is not https" };
  }
  const raw = JSON.stringify({
    ts: now(), receipt: inv.source_ref, kind,
    // The shop's dashboard shows couriers by name; the invoicer stores an id.
    courier: carrierName(inv.courier) || String(inv.courier || ""),
    tracking: String(inv.tracking_id || ""),
  });
  const signature = await hmacHex("invoicer->shop\n" + raw, secret);
  // One immediate retry for a network error or a 5xx — the transient failures
  // (the shop mid-deploy, an edge 502). Not for a 4xx: a refusal (cancelled
  // order, bad signature) will not change on a second try. No queue, no cron:
  // if it still fails, the caller tells the owner in the dashboard.
  let last = { ok: false, error: "not attempted" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    // A deadline on each attempt, covering the response body too, so a shop that
    // accepts the connection and never answers cannot hold up the WhatsApp send.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("shop did not answer in time")), ATTEMPT_MS);
    try {
      const res = await fetch(`${url}/api/sync/shipment`, {
        signal: ac.signal,
        method: "POST",
        // Never follow a redirect: it would forward the signature and the
        // customer's tracking details to wherever it pointed. "manual", not
        // "error" — Workers reject "error" at runtime; a redirect is refused below.
        redirect: "manual",
        headers: { "Content-Type": "application/json", "User-Agent": "invoicer/1.0", "x-invoicer-signature": signature },
        body: raw,
      });
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        console.error("shop shipment sync", kind, inv.source_ref, "redirect refused", res.status);
        return { ok: false, status: res.status, error: "the shop answered with a redirect — refused" };
      }
      const parsed = await Promise.race([
        res.json().catch(() => ({})),
        new Promise((_, rej) => ac.signal.addEventListener("abort", () => rej(ac.signal.reason || new Error("timeout")), { once: true })),
      ]);
      // A JSON null (or any non-object) reads as an empty answer, not a crash.
      const body = parsed && typeof parsed === "object" ? parsed : {};
      if (res.ok) {
        console.log("shop shipment sync", kind, inv.source_ref, body.already ? "already" : body.status, body.emailed ? "emailed" : "");
        return { ok: true, status: res.status, body };
      }
      console.error("shop shipment sync", kind, inv.source_ref, res.status, JSON.stringify(body).slice(0, 160));
      last = { ok: false, status: res.status, body, error: body?.error || `HTTP ${res.status}` };
      if (res.status < 500) return last;
    } catch (e) {
      console.error("shop shipment sync error", kind, inv.source_ref, e?.message || e);
      last = { ok: false, error: String(e?.message || e) };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

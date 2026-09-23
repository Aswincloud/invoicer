/* Who may make this deployment DO something outward: print on the office
 * printer, send an email, message a customer on WhatsApp.
 *
 * Invoicer is open to any provider-verified sign-in ("public" access mode), so
 * "signed in" is not authorisation. Someone with a Google account can create
 * an account here in one click. Before this file, that account could email and
 * WhatsApp from Aswin's business number and Resend domain: it could not reach
 * anyone else's invoices - every query is scoped by user_id - but it could send
 * its OWN invoices out under the deployment's identity, paying with Aswin's
 * Meta and Resend accounts. A third account appeared on 23 Sep and made the gap
 * concrete.
 *
 * Printing already had exactly this gate (PRINT_ALLOWED_EMAILS). It is now the
 * one rule for every outward action: a comma-separated allow-list, defaulting
 * to INVOICE_OWNER_EMAIL so a single-user deploy needs no extra configuration.
 * Fails CLOSED: no list and no owner means nobody may send. */

export function allowedSenders(env) {
  return String(env.SEND_ALLOWED_EMAILS || env.PRINT_ALLOWED_EMAILS || env.INVOICE_OWNER_EMAIL || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function maySend(env, email) {
  const who = String(email || "").trim().toLowerCase();
  if (!who) return false;
  return allowedSenders(env).includes(who);
}

/* Reading, saving and downloading stay open to every account - those touch
 * only the caller's own rows and cost nothing. */

// The public pay page embeds invoice details inside a <script> block.
//
// JSON.stringify escapes quotes but NOT `</`, so a value containing
// "</script>" closes the block early and everything after it parses as HTML —
// script execution on a page shown to a paying client.
//
// This is reachable by someone who is not the invoice owner: client_name on a
// shop-raised invoice comes straight from `customer.name` at checkout
// (src/ingest.js). So it is a regression test, not a theoretical one.

import { sharePage } from "../src/pay.js";

const HOSTILE = '</script><script>window.__pwned=1</script>';

// Minimal fakes: sharePage only needs DB.prepare().bind().first()/.all().
function fakeEnv(inv, items) {
  return {
    PAY_ENABLED: "true",
    RAZORPAY_KEY_ID: "rzp_test_x",
    RAZORPAY_KEY_SECRET: "s",
    APP_BASE_URL: "https://example.test",
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              first: async () => (sql.includes("FROM invoices i") ? inv : null),
              all: async () => ({ results: items }),
            };
          },
        };
      },
    },
  };
}

const inv = {
  id: "inv1", number: `INV-1${HOSTILE}`, currency: "₹", status: "UNPAID",
  tax_mode: "none", tax_rate: 0,
  client_name: HOSTILE, client_email: "a@b.co",
  biz_name: `Acme${HOSTILE}`, biz_logo: "",
};
const items = [{ description: "Widget", qty: 1, rate: 500 }];

const res = await sharePage(fakeEnv(inv, items), "a".repeat(32));
const html = await res.text();

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!cond) failed++;
};

check("page rendered", res.status === 200 && html.includes("<script>"));

// The ONLY </script> tags in the document must be the two real ones that close
// the Checkout include and the inline block. A third means a value broke out.
const closers = (html.match(/<\/script>/gi) || []).length;
check("no injected </script>", closers === 2, `found ${closers}, expected 2`);

check("hostile string is escaped in the script block",
  html.includes("\\u003c/script") || !html.includes(`${HOSTILE}`) ,
  "");

// The escaped form must still decode back to the original — escaping that
// mangles the client's name would be a different bug.
const m = html.match(/var CFG = (\{.*?\});/s);
check("CFG parses", Boolean(m));
if (m) {
  // eslint-disable-next-line no-eval — this is exactly what the browser does.
  const cfg = JSON.parse(m[1].replace(/\\u003c/g, "<"));
  check("client name round-trips intact", cfg.prefill.name === HOSTILE,
    JSON.stringify(cfg.prefill.name).slice(0, 60));
  check("business name round-trips intact", cfg.name === `Acme${HOSTILE}`);
}

// And the HTML-context interpolations (title, button label) must be escaped too.
check("title is HTML-escaped", !/<title>[^<]*<script>/i.test(html));

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);

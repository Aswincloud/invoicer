// Who may send. Signed-in is not authorisation on a deployment anyone with a
// Google account can join; the allow-list is, and it must fail closed.
import { maySend, allowedSenders } from "../src/access.js";
let failed = 0;
const check = (l, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`); if (!c) failed++; };

console.log("— defaults to the owner —");
const owner = { INVOICE_OWNER_EMAIL: "aswin@example.com" };
check("owner may send", maySend(owner, "aswin@example.com"));
check("case and whitespace do not matter", maySend(owner, "  Aswin@Example.com "));
check("a stranger who signed in may not", !maySend(owner, "user@example.com"));
check("empty email may not", !maySend(owner, "") && !maySend(owner, null) && !maySend(owner, undefined));

console.log("\n— explicit lists win over the owner default —");
const list = { INVOICE_OWNER_EMAIL: "aswin@example.com", SEND_ALLOWED_EMAILS: "a@x.test, b@x.test" };
check("listed may send", maySend(list, "b@x.test"));
check("the owner is NOT implied when a list is set", !maySend(list, "aswin@example.com"));
check("PRINT_ALLOWED_EMAILS still honoured as the list", maySend({ PRINT_ALLOWED_EMAILS: "p@x.test" }, "p@x.test"));
check("SEND_ALLOWED_EMAILS outranks PRINT_ALLOWED_EMAILS",
  maySend({ SEND_ALLOWED_EMAILS: "s@x.test", PRINT_ALLOWED_EMAILS: "p@x.test" }, "s@x.test")
  && !maySend({ SEND_ALLOWED_EMAILS: "s@x.test", PRINT_ALLOWED_EMAILS: "p@x.test" }, "p@x.test"));

console.log("\n— fails closed —");
check("no config at all: nobody may send", !maySend({}, "anyone@x.test"));
check("blank config: nobody may send", !maySend({ INVOICE_OWNER_EMAIL: " " }, "anyone@x.test"));
check("allowedSenders is empty then", allowedSenders({}).length === 0);

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);

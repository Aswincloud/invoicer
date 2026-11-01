// Saved customers (migration 0027). Pinned: the key (mobile, else name), that
// a save upserts without erasing details the new invoice left blank, that the
// search is scoped to the signed-in account and matches name, mobile and email,
// that a failed upsert never fails the save, and that the migration's seed SQL
// keys customers the same way the code does.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { customerKey, rememberCustomer, searchCustomers, deleteCustomer } from "../src/customers.js";

let failed = 0;
const check = (l, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`); if (!c) failed++; };

check("key: mobile wins", customerKey("Priya R", "919876543210") === "p:919876543210");
check("key: else the name, normalised", customerKey("  Priya   R ", "") === "n:priya r");
check("key: nothing to key on", customerKey("", "") === "");

// A real SQLite with the real migrations, so the SQL itself is tested.
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE invoices (id TEXT, user_id TEXT, status TEXT, client_name TEXT, client_phone TEXT, client_email TEXT, client_addr TEXT, client_gst TEXT, created_at INTEGER);`);
const ins = db.prepare("INSERT INTO invoices VALUES (?,?,?,?,?,?,?,?,?)");
ins.run("a", "u1", "PAID", "Hitesh", "919000000001", "", "Old addr, Pune", "", 1);
ins.run("b", "u1", "PAID", "Hitesh Ubhe", "919000000001", "h@x.in", "Ubhe Snacks, Pune 411030", "", 2);
ins.run("c", "u1", "VOID", "Cancelled Guy", "919000000002", "", "", "", 3);
ins.run("d", "u1", "UNPAID", "Walk-in Ravi", "", "", "Counter", "", 4);
ins.run("e", "u2", "PAID", "Other Account", "919000000003", "", "", "", 5);
ins.run("f", "u1", "PAID", "Old Name", "919000000004", "o@x.in", "Old address", "29AAAAA0000A1Z5", 6);
ins.run("g", "u1", "PAID", "", "919000000004", "", "", "", 7);          // newest for that phone has no name
ins.run("h", "u1", "PAID", "Mira  Das", "", "", "Kolkata", "", 8);   // double space, no phone
ins.run("i", "u1", "PAID", "Mira Das", "", "m@x.in", "", "", 9);
db.exec(readFileSync(new URL("../migrations/0027_customers.sql", import.meta.url), "utf8"));
const all = db.prepare("SELECT user_id, ckey, name, email, addr, invoices FROM customers ORDER BY ckey").all();
check("seed: one row per customer per account, VOID ignored", all.length === 5, JSON.stringify(all.map((r) => r.ckey)));
const o = all.find((r) => r.ckey === "p:919000000004");
check("seed: a newest invoice with no name doesn't hide the customer", o?.name === "Old Name" && o.email === "o@x.in");
const m = all.find((r) => r.ckey === customerKey("Mira  Das", ""));
check("seed: name keys collapse spaces exactly as customerKey does (one Mira, not two)", !!m && all.filter((r) => r.ckey.startsWith("n:mira")).length === 1, JSON.stringify(all.map((r) => r.ckey)));
check("seed: a later blank never erases an earlier detail", m?.addr === "Kolkata" && m.email === "m@x.in", JSON.stringify(m));
const h = all.find((r) => r.ckey === "p:919000000001");
check("seed: newest invoice's details win, both invoices counted", h?.name === "Hitesh Ubhe" && h.email === "h@x.in" && h.addr.includes("411030") && h.invoices === 2, JSON.stringify(h));
check("seed: a customer with no mobile is keyed by name, as the code does", all.some((r) => r.ckey === customerKey("Walk-in Ravi", "")));
check("seed: another account's customer stays in that account", all.find((r) => r.ckey === "p:919000000003")?.user_id === "u2");

// The seed must equal what rememberCustomer would have built by saving the
// same invoices one at a time.
{
  const db2 = new DatabaseSync(":memory:");
  db2.exec(readFileSync(new URL("../migrations/0027_customers.sql", import.meta.url), "utf8").replace(/INSERT INTO customers[\s\S]*$/, ""));
  const e2 = { DB: { prepare(sql) { const st = db2.prepare(sql); const make = (a) => ({ bind: (...x) => make(x), async run() { st.run(...a); return { meta: {} }; } }); return make([]); } } };
  for (const r of db.prepare("SELECT * FROM invoices WHERE status<>'VOID' ORDER BY created_at").all())
    await rememberCustomer(e2, r.user_id, r);
  const pick = (d) => d.prepare("SELECT user_id, ckey, name, phone, email, addr, gst, invoices FROM customers ORDER BY user_id, ckey").all().map((r) => JSON.stringify({ ...r }));
  check("seed equals replaying every save through rememberCustomer", JSON.stringify(pick(db)) === JSON.stringify(pick(db2)), "\n   seed:   " + pick(db).join("\n           ") + "\n   replay: " + pick(db2).join("\n           "));
}

// D1-shaped wrapper over node:sqlite for the module under test.
const env = { DB: { prepare(sql) { const st = db.prepare(sql); const make = (a) => ({ bind: (...x) => make(x),
  async all() { return { results: st.all(...a) }; }, async first() { return st.get(...a) ?? null; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }); return make([]); } } };
const q = async (user, s) => (await (await searchCustomers(env, user, new URL("https://x/api/customers?q=" + encodeURIComponent(s)))).json()).customers;

await rememberCustomer(env, "u1", { client_name: "Hitesh U.", client_phone: "919000000001", client_email: "", client_addr: "", client_gst: "27ABCDE1234F1Z5", status: "PAID" });
const h2 = db.prepare("SELECT * FROM customers WHERE ckey='p:919000000001'").get();
check("save: same mobile updates the one row, name follows the latest", h2.name === "Hitesh U." && h2.invoices === 3);
check("save: blanks on the new invoice don't erase earlier email/address", h2.email === "h@x.in" && h2.addr.includes("411030"));
check("save: a newly given GSTIN is stored", h2.gst === "27ABCDE1234F1Z5");
await rememberCustomer(env, "u1", { client_name: "Hitesh U.", client_phone: "919000000001", status: "PAID" }, { isNew: false });
check("save: editing an existing invoice doesn't count as another invoice", db.prepare("SELECT invoices FROM customers WHERE ckey='p:919000000001'").get().invoices === 3);
await rememberCustomer(env, "u1", { client_name: "Priya R", client_phone: "", client_addr: "Chennai", status: "UNPAID" });
check("save: a new customer without mobile is created by name", !!db.prepare("SELECT 1 FROM customers WHERE ckey='n:priya r'").get());
await rememberCustomer(env, "u1", { client_name: "Void Me", client_phone: "919000000009", status: "VOID" });
check("save: a VOID invoice creates nobody", !db.prepare("SELECT 1 FROM customers WHERE ckey='p:919000000009'").get());
const before0 = db.prepare("SELECT COUNT(*) n FROM customers WHERE user_id='u1'").get().n;
await rememberCustomer(env, "u1", { client_name: "", client_phone: "", status: "PAID" });
const before = db.prepare("SELECT COUNT(*) n FROM customers WHERE user_id='u1'").get().n;
check("save: an invoice with no customer creates nobody", before === before0, `${before0} -> ${before}`);
const brokenEnv = { DB: { prepare() { throw new Error("db down"); } } };
let threw = false; try { await rememberCustomer(brokenEnv, "u1", { client_name: "X", client_phone: "", status: "PAID" }); } catch (_) { threw = true; }
check("save: a failed upsert never throws into the invoice save", !threw);

const U1 = { id: "u1" }, U2 = { id: "u2" };
check("search by part of the name", (await q(U1, "hite")).map((c) => c.name).join() === "Hitesh U.");
check("search by part of the mobile", (await q(U1, "000001")).length === 1);
check("search by email", (await q(U1, "h@x")).length === 1);
check("search is per account", (await q(U2, "hite")).length === 0 && (await q(U2, "other")).length === 1);
check("LIKE wildcards in the query are literal", (await q(U1, "%")).length === 0);
check("empty query lists recent customers, newest first", (await q(U1, ""))[0].name === "Priya R");
const pid = db.prepare("SELECT id FROM customers WHERE ckey='n:priya r'").get().id;
check("forget: someone else can't delete it", (await deleteCustomer(env, U2, pid)).status === 404);
check("forget: the owner can", (await deleteCustomer(env, U1, pid)).status === 200 && !db.prepare("SELECT 1 FROM customers WHERE id=?").get(pid));

console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);

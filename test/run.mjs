// Runs every test/*.mjs as its own process, which is how they are written: each
// file prints ok/FAIL lines from its own assert helper and sets the exit code
// itself. `node --test` would report them green even with failing assertions,
// because none of them use node:test — that mistake hid four red lines on
// 26 Sep 2026. This is what `npm test` and CI run.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = new URL("./", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== "run.mjs").sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(f, dir))], { encoding: "utf8" });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${f}`);
  if (!ok) {
    const lines = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => /FAIL|Error|error:/.test(l)).slice(0, 20);
    console.log(lines.map((l) => "     " + l).join("\n"));
  }
}
console.log(`\n${files.length - failed}/${files.length} suites passed`);
process.exit(failed ? 1 : 0);

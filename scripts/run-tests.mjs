import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function walk(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(p, acc);
    } else if (ent.name.endsWith(".test.ts")) {
      acc.push(p);
    }
  }
  return acc;
}

const tests = walk("src");
if (tests.length === 0) {
  console.error("No tests found");
  process.exit(1);
}
const r = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...tests],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);

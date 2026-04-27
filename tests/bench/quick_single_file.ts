import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { TypeScriptToUdonTranspiler } from "../../src/transpiler/index.js";

// Repo-relative default: this file lives at <repo>/tests/bench/, so the
// repo root is two levels up. The default fixture assumes a sibling
// repository (`../mahjong-t2/`) — pass any path as argv[2] to override.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_FIXTURE = path.resolve(
  REPO_ROOT,
  "../mahjong-t2/src/core/application/orchestrators/GameOrchestrator.ts",
);

const file = process.argv[2] ?? DEFAULT_FIXTURE;
if (!fs.existsSync(file)) {
  console.error("file not found:", file);
  process.exit(1);
}
const src = fs.readFileSync(file, "utf8");
console.log(`source ${file} (${src.length} bytes)`);

for (let i = 0; i < 3; i++) {
  const t0 = performance.now();
  try {
    const r = new TypeScriptToUdonTranspiler().transpile(src);
    const dt = performance.now() - t0;
    console.log(`  run ${i + 1}: ${dt.toFixed(0)}ms uasm=${r.uasm.length}`);
  } catch (e) {
    const dt = performance.now() - t0;
    console.log(
      `  run ${i + 1} failed at ${dt.toFixed(0)}ms: ${(e as Error).message.slice(0, 200)}`,
    );
  }
}

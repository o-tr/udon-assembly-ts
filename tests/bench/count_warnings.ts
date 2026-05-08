/**
 * Collect and summarize transpile warnings from mahjong-t2.
 * Usage: pnpm tsx tests/bench/count_warnings.ts
 *
 * NOTE: As of 2026-05-08 the full batch compile may fail due to pre-existing
 * issues in mahjong-t2 that are unrelated to warning-budget work:
 *   - src/core/network/logic/MasterStateManager.ts uses `setImmediate(() => {…})`
 *     which the transpiler rejects (callback must be a single call expression).
 *   - src/vrc/adapters/VRChatInputBridge.ts implements a UdonBehaviour interface
 *     without the @UdonBehaviour decorator.
 * When either batch throws, that directory's warnings are silently lost.  The
 * partial output is still printed; verify coverage by checking which entry
 * points produced output.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BatchTranspiler } from "../../src/transpiler/batch/batch_transpiler.js";
import type { TranspileWarning } from "../../src/transpiler/errors/transpile_errors.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const MAHJONG_DIRS = [
  process.env.MAHJONG_SRC_CORE ??
    path.resolve(REPO_ROOT, "../mahjong-t2/src/core"),
  process.env.MAHJONG_SRC_VRC ??
    path.resolve(REPO_ROOT, "../mahjong-t2/src/vrc"),
];

const allWarnings: TranspileWarning[] = [];

for (const srcDir of MAHJONG_DIRS) {
  if (!fs.existsSync(srcDir)) {
    console.error(`skip (not found): ${srcDir}`);
    continue;
  }
  const outDir = path.join(os.tmpdir(), "udon-warn-out", path.basename(srcDir));
  fs.mkdirSync(outDir, { recursive: true });
  const t = new BatchTranspiler();
  try {
    const result = t.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      silent: true,
      useOutputCache: false,
    });
    for (const w of result.diagnostics ?? []) {
      allWarnings.push(w);
    }
  } catch (err) {
    console.error(`\n[count_warnings] batch failed for ${srcDir}: ${(err as Error).message}`);
    console.error("  Warnings from this batch are not included in the count.\n");
  }
}

// Group by code
const byCode = new Map<string, number>();
for (const w of allWarnings) {
  byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1);
}

// Group by code+location (unique)
const bySite = new Map<string, { w: TranspileWarning; count: number }>();
for (const w of allWarnings) {
  const key = `${w.code}|${w.location.filePath}:${w.location.line}:${w.location.column}`;
  const ex = bySite.get(key);
  if (ex) ex.count++;
  else bySite.set(key, { w, count: 1 });
}

console.log(`\nTotal: ${allWarnings.length} warning(s) (${bySite.size} unique)\n`);
console.log("By code:");
for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${code}: ${n}`);
}
console.log("\nTop unique sites (top 30):");
const topSites = [...bySite.values()].sort((a, b) => b.count - a.count).slice(0, 30);
for (const { w, count } of topSites) {
  const loc = `${w.location.filePath.replace(/.*mahjong-t2\//, "")}:${w.location.line}:${w.location.column}`;
  console.log(`  x${count} [${w.code}] ${loc} — ${w.message.slice(0, 120)}`);
}

/**
 * Batch transpiler profiler
 *
 * Measures how BatchTranspiler cost scales with entry-point count so we can
 * verify plan item 7 (per-entry buildUdonBehaviourLayouts redundancy).
 *
 * Creates N entry UdonBehaviours in a tempdir, each referencing a shared
 * Service class, then runs BatchTranspiler with a cold cache and prints
 * wall-clock + per-entry average.
 *
 * Usage:
 *   pnpm tsx tests/bench/batch_profile.ts
 *   pnpm tsx tests/bench/batch_profile.ts --entries 1,2,4,8,16 --runs 3
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { BatchTranspiler } from "../../src/transpiler/batch/batch_transpiler.js";

interface Args {
  entries: number[];
  runs: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { entries: [1, 2, 4, 8, 16], runs: 3 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--entries") a.entries = argv[++i].split(",").map(Number);
    else if (arg === "--runs") a.runs = Number(argv[++i]);
  }
  return a;
}

function writeFixture(sourceDir: string, entryCount: number): void {
  // Shared service — single Calculator class referenced by every entry, so the
  // registry has one "non-entry" class that every entry sees. This mirrors a
  // real codebase where utility classes are imported into many UdonBehaviours.
  fs.writeFileSync(
    path.join(sourceDir, "Service.ts"),
    `
export class Service {
  private count: number = 0;
  getValue(x: number): number {
    let sum: number = 0;
    for (let i: number = 0; i < 4; i++) {
      sum = sum + x * i + this.count;
      if (sum > 100) sum = sum - 100;
    }
    return sum;
  }
}
`,
    "utf8",
  );

  for (let i = 0; i < entryCount; i++) {
    fs.writeFileSync(
      path.join(sourceDir, `Entry${i}.ts`),
      `
import { Service } from "./Service";

@UdonBehaviour()
class Entry${i} extends UdonSharpBehaviour {
  private svc: Service = new Service();
  private result: number = 0;
  Start(): void {
    this.result = this.svc.getValue(${i});
  }
  Update(): void {
    this.result = this.result + this.svc.getValue(${i} * 2);
  }
}
`,
      "utf8",
    );
  }
}

function runBatchOnce(root: string): number {
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  const cachePath = path.join(sourceDir, ".transpiler-cache.json");
  if (fs.existsSync(cachePath)) fs.rmSync(cachePath);

  const transpiler = new BatchTranspiler();
  const t0 = performance.now();
  transpiler.transpile({ sourceDir, outputDir, excludeDirs: [] });
  return performance.now() - t0;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const results: Array<{
    entries: number;
    median: number;
    perEntry: number;
  }> = [];

  for (const entryCount of args.entries) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "uasm-batch-profile-"));
    const sourceDir = path.join(root, "src");
    fs.mkdirSync(sourceDir, { recursive: true });
    writeFixture(sourceDir, entryCount);

    // Warmup
    runBatchOnce(root);

    const times: number[] = [];
    for (let i = 0; i < args.runs; i++) times.push(runBatchOnce(root));
    times.sort((a, b) => a - b);
    const med = times[Math.floor(times.length / 2)];
    results.push({
      entries: entryCount,
      median: med,
      perEntry: med / entryCount,
    });

    // Cleanup
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("\n=== BatchTranspiler scaling ===");
  console.table(
    results.map((r) => ({
      entries: r.entries,
      total_ms: r.median.toFixed(2),
      per_entry_ms: r.perEntry.toFixed(2),
    })),
  );

  // If per-entry grows with entry count, that's O(n²) behaviour — redundant
  // work happening per entry (the plan's item 7 hypothesis).
  if (results.length >= 2) {
    const first = results[0];
    const last = results[results.length - 1];
    const perEntryGrowth = last.perEntry / first.perEntry;
    const entryRatio = last.entries / first.entries;
    console.log(
      `\nPer-entry time ratio (${last.entries}/${first.entries}): ${perEntryGrowth.toFixed(2)}x  ` +
        `(entries grew ${entryRatio.toFixed(0)}x)\n` +
        `Linear scaling → ratio ≈ 1.0.  Super-linear → ratio > 1.0.`,
    );
  }
}

main();

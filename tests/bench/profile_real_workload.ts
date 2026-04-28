/**
 * Real-workload profile harness.
 *
 * Runs BatchTranspiler against a target directory (default: mahjong-t2 src/core
 * + src/vrc) so v8's --cpu-prof can attribute time across the actual hot path.
 *
 * Usage:
 *   pnpm tsx tests/bench/profile_real_workload.ts [-i <dir>...] [--no-optimize]
 *
 * To capture a CPU profile:
 *   node --cpu-prof --cpu-prof-name=/tmp/transpile.cpuprofile \
 *        --import tsx tests/bench/profile_real_workload.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { BatchTranspilerOptions } from "../../src/transpiler/batch/batch_transpiler.js";
import { BatchTranspiler } from "../../src/transpiler/batch/batch_transpiler.js";
import type { EntryProfile } from "../../src/transpiler/ir/ast_to_tac/profiling.js";

// Repo-relative defaults: this file lives at <repo>/tests/bench/, so the
// repo root is two levels up. The default workload assumes a sibling
// repository (`../mahjong-t2/`) — override with one or more `-i <dir>`.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_INPUT_DIRS = [
  path.resolve(REPO_ROOT, "../mahjong-t2/src/core"),
  path.resolve(REPO_ROOT, "../mahjong-t2/src/vrc"),
];

interface PersistedProfile {
  metadata: {
    timestamp: string;
    inputs: string[];
    optimize: boolean;
  };
  entries: Record<string, EntryProfile>;
}

interface Args {
  inputs: string[];
  optimize: boolean;
  output: string;
  clearCache: boolean;
  saveProfile?: string;
  compareProfile?: string;
}

const HELP = `Usage: tsx tests/bench/profile_real_workload.ts [options]

Options:
  -i, --input <dir>     Add a source directory (repeatable). Defaults to
                        ../mahjong-t2/src/{core,vrc} relative to repo root.
  -o, --output <dir>    Output directory (default: a tmpdir).
      --no-optimize     Disable the optimizer pass.
      --keep-cache      Do not clear .transpiler-cache.json / .transpiler-optcache
                        before running.
  -s, --save-profile <file>
                        Save UDON_PROFILE=1 histograms to JSON.
  -c, --compare-profile <file>
                        Compare current run against a saved baseline JSON.
  -h, --help            Show this help and exit.
`;

function parseArgs(argv: string[]): Args {
  const a: Args = {
    inputs: [],
    optimize: true,
    output: path.join(os.tmpdir(), "udon-profile-out"),
    clearCache: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "-i" || x === "--input") {
      const v = argv[++i];
      if (!v) throw new Error("missing value for -i");
      a.inputs.push(v);
    } else if (x === "--no-optimize") {
      a.optimize = false;
    } else if (x === "-o" || x === "--output") {
      const v = argv[++i];
      if (!v) throw new Error("missing value for -o");
      a.output = v;
    } else if (x === "--keep-cache") {
      a.clearCache = false;
    } else if (x === "-s" || x === "--save-profile") {
      const v = argv[++i];
      if (!v) throw new Error("missing value for --save-profile");
      a.saveProfile = v;
    } else if (x === "-c" || x === "--compare-profile") {
      const v = argv[++i];
      if (!v) throw new Error("missing value for --compare-profile");
      a.compareProfile = v;
    } else if (x === "-h" || x === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${x} (use -h for help)`);
    }
  }
  if (a.inputs.length === 0) {
    a.inputs = [...DEFAULT_INPUT_DIRS];
  }
  return a;
}

function fmt(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString("en-US");
}

function loadBaseline(filePath: string): PersistedProfile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(
      `Cannot read baseline: ${filePath} — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in baseline: ${filePath}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("entries" in parsed) ||
    !("metadata" in parsed) ||
    typeof parsed.metadata !== "object" ||
    !parsed.metadata ||
    !parsed.entries ||
    typeof parsed.entries !== "object"
  ) {
    throw new Error(`Invalid profile JSON schema: ${filePath}`);
  }
  return parsed as PersistedProfile;
}

function compareHistogram(
  label: string,
  baseline: Record<
    string,
    { selfInstr: number; callsTotal: number; callsPass1: number }
  >,
  current: Record<
    string,
    { selfInstr: number; callsTotal: number; callsPass1: number }
  >,
  totalInstrBase: number,
  totalInstrCurr: number,
) {
  type Row = {
    key: string;
    baseSelf: number;
    currSelf: number;
    diffSelf: number;
    baseCallsP2: number;
    currCallsP2: number;
    diffCallsP2: number;
  };

  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const rows: Row[] = [];
  for (const key of allKeys) {
    const b = baseline[key];
    const c = current[key];
    const baseSelf = b?.selfInstr ?? 0;
    const currSelf = c?.selfInstr ?? 0;
    const baseCallsP2 = b ? b.callsTotal - b.callsPass1 : 0;
    const currCallsP2 = c ? c.callsTotal - c.callsPass1 : 0;
    rows.push({
      key,
      baseSelf,
      currSelf,
      diffSelf: currSelf - baseSelf,
      baseCallsP2,
      currCallsP2,
      diffCallsP2: currCallsP2 - baseCallsP2,
    });
  }

  rows.sort((a, b) => {
    const da = Math.abs(b.diffSelf) - Math.abs(a.diffSelf);
    if (da !== 0) return da;
    return a.key.localeCompare(b.key);
  });

  console.log(`\n[compare] Entry: ${label}`);
  console.log(
    `  ${"Method".padEnd(48)} ${"selfInstr (diff)".padStart(22)} ${"calls(p2) (diff)".padStart(18)}`,
  );
  console.log(`  ${"-".repeat(48)} ${"-".repeat(22)} ${"-".repeat(18)}`);

  const limit = Math.min(30, rows.length);
  for (let i = 0; i < limit; i++) {
    const r = rows[i];
    if (r.baseSelf === 0 && r.currSelf === 0) continue;
    const selfStr = `${fmtNum(r.currSelf)} (${r.diffSelf >= 0 ? "+" : ""}${fmtNum(r.diffSelf)})`;
    const callsStr = `${fmtNum(r.currCallsP2)} (${r.diffCallsP2 >= 0 ? "+" : ""}${fmtNum(r.diffCallsP2)})`;
    console.log(
      `  ${r.key.padEnd(48)} ${selfStr.padStart(22)} ${callsStr.padStart(18)}`,
    );
  }

  const totalDiff = totalInstrCurr - totalInstrBase;
  const totalPct =
    totalInstrBase > 0
      ? ((totalDiff / totalInstrBase) * 100).toFixed(1)
      : "0.0";
  console.log(`  ${"-".repeat(48)} ${"-".repeat(22)} ${"-".repeat(18)}`);
  const totalStr = `${fmtNum(totalInstrCurr)} (${totalDiff >= 0 ? "+" : ""}${fmtNum(totalDiff)} / ${totalPct}%)`;
  console.log(
    `  ${"Total instructions (pass2)".padEnd(48)} ${totalStr.padStart(22)} ${"".padStart(18)}`,
  );
}

function compareKindHistogram(
  label: string,
  baseline: Record<string, number>,
  current: Record<string, number>,
) {
  type Row = { key: string; base: number; curr: number; diff: number };
  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const rows: Row[] = [];
  for (const key of allKeys) {
    const b = baseline[key] ?? 0;
    const c = current[key] ?? 0;
    rows.push({ key, base: b, curr: c, diff: c - b });
  }
  rows.sort((a, b) => {
    const da = Math.abs(b.diff) - Math.abs(a.diff);
    if (da !== 0) return da;
    return a.key.localeCompare(b.key);
  });
  console.log(`\n[compare] Kind histogram: ${label}`);
  const limit = Math.min(20, rows.length);
  for (let i = 0; i < limit; i++) {
    const r = rows[i];
    if (r.base === 0 && r.curr === 0) continue;
    const diffStr = `${r.diff >= 0 ? "+" : ""}${fmtNum(r.diff)}`;
    console.log(
      `  ${r.key.padEnd(32)} ${fmtNum(r.curr).padStart(14)} (base=${fmtNum(r.base)}, diff=${diffStr})`,
    );
  }
}

function compareProfiles(
  baseline: PersistedProfile,
  current: PersistedProfile,
) {
  const allEntries = new Set([
    ...Object.keys(baseline.entries),
    ...Object.keys(current.entries),
  ]);
  for (const entryName of allEntries) {
    const b = baseline.entries[entryName];
    const c = current.entries[entryName];
    if (!b || !c) {
      console.log(
        `\n[compare] Entry: ${entryName} ${b ? "(missing in current)" : "(missing in baseline)"}`,
      );
      continue;
    }
    compareHistogram(
      entryName,
      b.inlineHistogram,
      c.inlineHistogram,
      b.totalInstrCount,
      c.totalInstrCount,
    );
    compareKindHistogram(
      entryName,
      b.instructionKindHistogram,
      c.instructionKindHistogram,
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.saveProfile || args.compareProfile) {
    if (process.env.UDON_PROFILE !== "1") {
      console.error(
        "[profile] UDON_PROFILE=1 is required for --save-profile and --compare-profile",
      );
      process.exit(1);
    }
  }

  if (args.clearCache) {
    for (const input of args.inputs) {
      const cachePath = path.join(input, ".transpiler-cache.json");
      if (fs.existsSync(cachePath)) fs.rmSync(cachePath);
      const optCache = path.join(input, ".transpiler-optcache");
      if (fs.existsSync(optCache)) fs.rmSync(optCache, { recursive: true });
    }
  }

  fs.mkdirSync(args.output, { recursive: true });

  const overallStart = performance.now();
  let totalEntries = 0;
  let totalUasmBytes = 0;
  const allProfiles: Record<string, EntryProfile> = {};

  // Suffix output dirs with the input index so two inputs sharing a basename
  // (e.g. `-i a/src -i b/src`) don't overwrite each other's outputs and
  // double-count `totalUasmBytes`.
  for (const [index, input] of args.inputs.entries()) {
    if (!fs.existsSync(input)) {
      console.error(`skip (not found): ${input}`);
      continue;
    }
    const transpiler = new BatchTranspiler();
    const outDirName = `${index.toString().padStart(2, "0")}-${path.basename(input)}`;
    const outDir = path.join(args.output, outDirName);
    fs.mkdirSync(outDir, { recursive: true });

    const opts: BatchTranspilerOptions = {
      sourceDir: input,
      outputDir: outDir,
      optimize: args.optimize,
      excludeDirs: [],
      includeExternalDependencies: true,
      outputExtension: "tasm",
    };

    const t0 = performance.now();
    let result: ReturnType<typeof transpiler.transpile> | undefined;
    try {
      result = transpiler.transpile(opts);
    } catch (err) {
      // Don't let one bad input drop the wall-clock summary. Log and
      // continue; the footer below still prints what we did get.
      const t1 = performance.now();
      console.error(
        `[input ${input}] FAILED after ${fmt(t1 - t0)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const t1 = performance.now();

    totalEntries += result.outputs.length;
    for (const o of result.outputs) {
      try {
        const stat = fs.statSync(o.outputPath);
        totalUasmBytes += stat.size;
      } catch (err) {
        // Surface unexpected I/O errors instead of silently dropping the
        // entry from the byte total. Missing output usually means the
        // entry write failed upstream — visibility matters during
        // bench debugging.
        console.error(
          `stat failed for ${o.outputPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (result.profiles) {
      for (const [entryName, profile] of Object.entries(result.profiles)) {
        // If the same entry name appears in multiple inputs, keep the first or
        // overwrite. This mirrors the behaviour of `outputs` today.
        allProfiles[entryName] = profile;
      }
    }

    console.log(
      `[input ${input}] entries=${result.outputs.length} took=${fmt(t1 - t0)}`,
    );
  }

  const overallEnd = performance.now();
  console.log("");
  console.log(
    `Total wall-clock: ${fmt(overallEnd - overallStart)}  entries=${totalEntries}  uasm=${(totalUasmBytes / 1024 / 1024).toFixed(1)} MiB  optimize=${args.optimize}`,
  );

  if (args.saveProfile) {
    if (Object.keys(allProfiles).length === 0) {
      console.error(
        "[profile] no profile data collected — no entries transpiled successfully",
      );
      process.exit(1);
    } else {
      const payload: PersistedProfile = {
        metadata: {
          timestamp: new Date().toISOString(),
          inputs: args.inputs,
          optimize: args.optimize,
        },
        entries: allProfiles,
      };
      fs.writeFileSync(
        args.saveProfile,
        JSON.stringify(payload, null, 2),
        "utf8",
      );
      console.log(`[profile] saved to ${args.saveProfile}`);
    }
  }

  if (args.compareProfile) {
    if (Object.keys(allProfiles).length === 0) {
      console.error(
        "[compare] no profile data collected — rerun with UDON_PROFILE=1",
      );
      process.exit(1);
    }
    const baseline = loadBaseline(args.compareProfile);
    if (baseline.metadata.optimize !== args.optimize) {
      console.warn(
        `[compare] warning: baseline optimize=${baseline.metadata.optimize} but current optimize=${args.optimize}`,
      );
    }
    const current: PersistedProfile = {
      metadata: {
        timestamp: new Date().toISOString(),
        inputs: args.inputs,
        optimize: args.optimize,
      },
      entries: allProfiles,
    };
    compareProfiles(baseline, current);
  }
}

main();

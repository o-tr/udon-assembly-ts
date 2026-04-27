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

// Repo-relative defaults: this file lives at <repo>/tests/bench/, so the
// repo root is two levels up. The default workload assumes a sibling
// repository (`../mahjong-t2/`) — override with one or more `-i <dir>`.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_INPUT_DIRS = [
  path.resolve(REPO_ROOT, "../mahjong-t2/src/core"),
  path.resolve(REPO_ROOT, "../mahjong-t2/src/vrc"),
];

interface Args {
  inputs: string[];
  optimize: boolean;
  output: string;
  clearCache: boolean;
}

const HELP = `Usage: tsx tests/bench/profile_real_workload.ts [options]

Options:
  -i, --input <dir>   Add a source directory (repeatable). Defaults to
                      ../mahjong-t2/src/{core,vrc} relative to repo root.
  -o, --output <dir>  Output directory (default: a tmpdir).
      --no-optimize   Disable the optimizer pass.
      --keep-cache    Do not clear .transpiler-cache.json / .transpiler-optcache
                      before running.
  -h, --help          Show this help and exit.
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

function main() {
  const args = parseArgs(process.argv.slice(2));

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
    const result = transpiler.transpile(opts);
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
    console.log(
      `[input ${input}] entries=${result.outputs.length} took=${fmt(t1 - t0)}`,
    );
  }

  const overallEnd = performance.now();
  console.log("");
  console.log(
    `Total wall-clock: ${fmt(overallEnd - overallStart)}  entries=${totalEntries}  uasm=${(totalUasmBytes / 1024 / 1024).toFixed(1)} MiB  optimize=${args.optimize}`,
  );
}

main();

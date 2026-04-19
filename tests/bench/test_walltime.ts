/**
 * Measures wall-clock time of `pnpm test` by spawning it as a child process.
 * Runs `--runs N` times (default 3) and reports min / median / mean.
 *
 * Usage:
 *   pnpm test:time              # default 3 runs
 *   pnpm test:time --runs 5
 *   pnpm test:time --json out.json
 *
 * The vitest exit code of each run is honored — if any run fails, the script
 * exits non-zero after printing the partial results.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

interface Args {
  runs: number;
  json?: string;
  cmd: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { runs: 3, cmd: ["pnpm", "test"] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`--runs requires a positive integer (got "${raw}")`);
        process.exit(2);
      }
      args.runs = n;
    } else if (a === "--json") {
      const p = argv[++i];
      if (!p || p.startsWith("--")) {
        console.error(`--json requires a path (got "${p ?? "<missing>"}")`);
        process.exit(2);
      }
      args.json = p;
    } else if (a === "--") {
      args.cmd = argv.slice(i + 1);
      break;
    } else {
      console.warn(`Unknown arg: ${a}`);
    }
  }
  return args;
}

function runOnce(cmd: string[]): Promise<{ ms: number; code: number }> {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ ms: performance.now() - start, code });
    };
    child.on("error", (err) => {
      console.error(`spawn error: ${err.message}`);
      finish(-1);
    });
    child.on("close", (code) => {
      finish(code ?? -1);
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const results: Array<{ ms: number; code: number }> = [];
  let anyFailed = false;

  for (let i = 0; i < args.runs; i++) {
    console.log(`\n--- test run ${i + 1} / ${args.runs} ---`);
    const r = await runOnce(args.cmd);
    results.push(r);
    if (r.code !== 0) {
      anyFailed = true;
      console.error(`Run ${i + 1} exited ${r.code}`);
    }
  }

  const ms = results.map((r) => r.ms);
  const sorted = [...ms].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;

  const fmt = (n: number) => `${(n / 1000).toFixed(2)} s`;
  console.log("\n=== pnpm test wall-clock ===");
  console.table({
    min: fmt(min),
    median: fmt(median),
    mean: fmt(mean),
    max: fmt(max),
    runs: String(ms.length),
  });

  if (args.json) {
    const payload = {
      cmd: args.cmd,
      runs: results,
      summary: { min, median, mean, max },
    };
    fs.writeFileSync(args.json, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`Wrote ${args.json}`);
  }

  if (anyFailed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

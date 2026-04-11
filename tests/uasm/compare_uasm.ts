/**
 * UASM comparison report generator.
 *
 * Compiles UdonSharp C# files via Unity batch mode, transpiles the equivalent
 * TypeScript files, then compares the two UASM outputs and prints a report.
 *
 * Usage:
 *   UNITY_EDITOR_PATH=<path> pnpm run compare:uasm
 *
 * If UNITY_EDITOR_PATH is not set, only the TS transpiler output is reported.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BatchTranspiler } from "../../src/transpiler/batch/batch_transpiler.js";
import { parseUasm, type UasmData } from "./uasm_parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UNITY_PROJECT_PATH = path.resolve(__dirname, "../vm/unity-project");
const SAMPLES_DIR = path.resolve(__dirname, "sample");
const UNITY_EDITOR_PATH = process.env.UNITY_EDITOR_PATH ?? "";

interface TestCase {
  name: string;
  sampleDir: string;
  csFiles: string[];
  tsFiles: string[];
}

interface CaseReport {
  name: string;
  udonSharpUasm: UasmData | null;
  tasmUasm: UasmData | null;
  tasmOptimizedUasm: UasmData | null;
  udonSharpError: string | null;
  tasmError: string | null;
  tasmOptimizedError: string | null;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

function discoverTestCases(): TestCase[] {
  if (!existsSync(SAMPLES_DIR)) return [];

  return readdirSync(SAMPLES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const sampleDir = path.join(SAMPLES_DIR, e.name);
      const files = readdirSync(sampleDir);
      return {
        name: e.name,
        sampleDir,
        csFiles: files
          .filter((f) => f.endsWith(".cs"))
          .map((f) => path.join(sampleDir, f)),
        tsFiles: files
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
          .map((f) => path.join(sampleDir, f)),
      };
    })
    .filter((tc) => {
      if (tc.tsFiles.length === 0) {
        console.warn(`  Skipping sample "${tc.name}": no .ts files (only .cs)`);
        return false;
      }
      return true;
    });
}

// ─── UdonSharp compilation ────────────────────────────────────────────────────

interface CompileResultEntry {
  name: string;
  className: string;
  uasmFile: string;
  error: string;
}

interface UdonSharpCompileResult {
  uasms: Map<string, Map<string, string>>;
  errors: Map<string, Map<string, string>>;
}

function runUdonSharpCompiler(
  cases: TestCase[],
  inputDir: string,
  outputDir: string,
): UdonSharpCompileResult {
  const uasmByName = new Map<string, Map<string, string>>();
  const errorsByName = new Map<string, Map<string, string>>();
  const casesWithCs = cases.filter((c) => c.csFiles.length > 0);
  if (casesWithCs.length === 0)
    return { uasms: uasmByName, errors: errorsByName };

  // Write manifest
  const sources = casesWithCs.flatMap((tc) =>
    tc.csFiles.map((f) => ({
      name: tc.name,
      className: path.basename(f, ".cs"),
    })),
  );
  writeFileSync(
    path.join(inputDir, "compile_manifest.json"),
    JSON.stringify({ sources }, null, 2),
    "utf-8",
  );

  // Copy .cs files into Assets/UdonSharpInput/ BEFORE Unity starts so they are
  // compiled during Unity's startup domain reload (AssetDatabase.Refresh() in
  // batch mode does NOT trigger a domain reload for new scripts).
  // NOTE: UdonSharp requires filename == class name, so these keep original
  // basenames. Duplicate class names across test cases will cause compile errors.
  const assetsInputDir = path.join(
    UNITY_PROJECT_PATH,
    "Assets",
    "UdonSharpInput",
  );
  const assetsInputMeta = `${assetsInputDir}.meta`;
  if (existsSync(assetsInputDir))
    rmSync(assetsInputDir, { recursive: true, force: true });
  if (existsSync(assetsInputMeta)) rmSync(assetsInputMeta, { force: true });
  mkdirSync(assetsInputDir, { recursive: true });

  const logFile = path.join(tmpdir(), `uasm-compare-${Date.now()}.log`);
  try {
    // Copy .cs files (inside try so cleanup runs even on duplicate-name throw)
    const seenBaseNames = new Set<string>();
    for (const tc of casesWithCs) {
      for (const csFile of tc.csFiles) {
        const baseName = path.basename(csFile);
        if (seenBaseNames.has(baseName)) {
          throw new Error(
            `Duplicate .cs filename "${baseName}" from test case "${tc.name}". ` +
              "UdonSharp requires unique class names across all test cases.",
          );
        }
        seenBaseNames.add(baseName);
        copyFileSync(csFile, path.join(assetsInputDir, baseName));
      }
    }

    // Run Unity batch mode
    const UNITY_TIMEOUT_MS = 300_000;
    const unityArgs = [
      "-batchmode",
      "-nographics",
      "-projectPath",
      UNITY_PROJECT_PATH,
      "-executeMethod",
      "UdonSharpCompileRunner.CompileToUasm",
      "-udonSharpInputDir",
      inputDir,
      "-udonSharpOutputDir",
      outputDir,
      "-logFile",
      logFile,
      "-quit",
    ];

    console.log("Running UdonSharp compiler (Unity batch mode)...");
    try {
      execFileSync(UNITY_EDITOR_PATH, unityArgs, {
        timeout: UNITY_TIMEOUT_MS,
      });
    } catch (err: unknown) {
      const spawnError = err as NodeJS.ErrnoException & {
        status?: number;
        killed?: boolean;
      };
      if (spawnError.killed) {
        try {
          rmSync(logFile, { force: true });
        } catch {
          /* ignore */
        }
        throw new Error(
          `Unity process timed out after ${UNITY_TIMEOUT_MS / 1000}s`,
        );
      }
      if (spawnError.code !== undefined && spawnError.status == null) throw err;
      console.warn(
        `  [UdonSharp] Unity exited with status ${spawnError.status ?? "(unknown)"}, checking for output...`,
      );
    }

    // Read results
    const resultsPath = path.join(outputDir, "compile_results.json");
    if (!existsSync(resultsPath)) {
      const logContent = existsSync(logFile)
        ? readFileSync(logFile, "utf-8")
            .split("\n")
            .filter((l) => l.includes("error") || l.includes("Error"))
            .slice(-20)
            .join("\n")
        : "(no log)";
      throw new Error(
        `Unity did not produce compile_results.json.\nLog excerpt:\n${logContent}`,
      );
    }

    const rawResults = JSON.parse(
      readFileSync(resultsPath, "utf-8").replace(/^\uFEFF/, ""),
    ) as { results: CompileResultEntry[] };

    for (const r of rawResults.results) {
      if (r.error) {
        console.error(
          `  [UdonSharp] ${r.name}/${r.className}: ERROR: ${r.error}`,
        );
        if (!errorsByName.has(r.name)) {
          errorsByName.set(r.name, new Map());
        }
        errorsByName.get(r.name)?.set(r.className, r.error);
        continue;
      }
      const uasmPath = path.join(outputDir, r.uasmFile);
      if (existsSync(uasmPath)) {
        const text = readFileSync(uasmPath, "utf-8").replace(/^\uFEFF/, "");
        if (!uasmByName.has(r.name)) {
          uasmByName.set(r.name, new Map());
        }
        uasmByName.get(r.name)?.set(r.className, text);
      }
    }

    return { uasms: uasmByName, errors: errorsByName };
  } finally {
    try {
      rmSync(logFile, { force: true });
    } catch {
      /* ignore */
    }
    // Clean up Assets/UdonSharpInput regardless of success/failure
    try {
      if (existsSync(assetsInputDir))
        rmSync(assetsInputDir, { recursive: true, force: true });
      if (existsSync(assetsInputMeta)) rmSync(assetsInputMeta, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// ─── TS transpilation ─────────────────────────────────────────────────────────

interface TasmTranspileResult {
  uasms: Map<string, Map<string, string>>;
  errors: Map<string, string>;
}

function transpileTs(
  cases: TestCase[],
  optimize = false,
): TasmTranspileResult {
  // uasms: caseName -> (className -> uasmText), errors: caseName -> errorMessage
  const result = new Map<string, Map<string, string>>();
  const errors = new Map<string, string>();

  const transpiler = new BatchTranspiler();

  for (const tc of cases) {
    if (tc.tsFiles.length === 0) continue;
    const tempDir = path.join(
      tmpdir(),
      `uasm-compare-ts-${tc.name}-${Math.random().toString(36).slice(2)}`,
    );
    const sourceDir = path.join(tempDir, "src");
    const outputDir = path.join(tempDir, "out");
    mkdirSync(sourceDir, { recursive: true });

    try {
      for (const tsFile of tc.tsFiles) {
        copyFileSync(tsFile, path.join(sourceDir, path.basename(tsFile)));
      }

      transpiler.transpile({
        sourceDir,
        outputDir,
        excludeDirs: [],
        outputExtension: "uasm",
        optimize,
      });

      const outputs = new Map<string, string>();
      if (existsSync(outputDir)) {
        for (const f of readdirSync(outputDir)) {
          if (f.endsWith(".uasm")) {
            outputs.set(
              path.basename(f, ".uasm"),
              readFileSync(path.join(outputDir, f), "utf-8"),
            );
          }
        }
      }
      result.set(tc.name, outputs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `  [TASM${optimize ? " optimized" : ""}] ${tc.name}: transpilation error: ${msg}`,
      );
      result.set(tc.name, new Map());
      errors.set(tc.name, msg);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return { uasms: result, errors };
}

// ─── Report ───────────────────────────────────────────────────────────────────

function setDiff<T>(a: T[], b: T[]): { onlyInA: T[]; onlyInB: T[]; both: T[] } {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyInA: a.filter((x) => !setB.has(x)),
    onlyInB: b.filter((x) => !setA.has(x)),
    both: a.filter((x) => setB.has(x)),
  };
}

function formatMetrics(label: string, d: UasmData): string {
  return `  [${label}] vars=${d.variables.length}  instructions=${d.instructionCount}  externs=${d.externs.length}  exports=${d.exports.length}`;
}

function printPairDiff(
  label: string,
  us: UasmData,
  ts: UasmData,
  tsLabel: string,
) {
  console.log(`  ── ${label} ──`);
  // Sync mode
  if (us.syncMode || ts.syncMode) {
    if (us.syncMode?.toLowerCase() === ts.syncMode?.toLowerCase()) {
      console.log(`  SyncMode (vs ${tsLabel}): MATCH (${us.syncMode})`);
    } else {
      console.log(
        `  SyncMode (vs ${tsLabel}): DIFF  UdonSharp=${us.syncMode ?? "(none)"}  ${tsLabel}=${ts.syncMode ?? "(none)"}`,
      );
    }
  }

  // Exports diff
  const exportsDiff = setDiff(us.exports, ts.exports);
  if (exportsDiff.onlyInA.length === 0 && exportsDiff.onlyInB.length === 0) {
    console.log(
      `  Exports (vs ${tsLabel}):  MATCH (${us.exports.join(", ")})`,
    );
  } else {
    console.log(
      `  Exports (vs ${tsLabel}):  DIFF  only-UdonSharp=[${exportsDiff.onlyInA.join(", ")}]  only-${tsLabel}=[${exportsDiff.onlyInB.join(", ")}]`,
    );
  }

  // Externs diff
  const externsDiff = setDiff(
    [...new Set(us.externs)],
    [...new Set(ts.externs)],
  );
  if (externsDiff.onlyInA.length === 0 && externsDiff.onlyInB.length === 0) {
    if (us.externs.length !== ts.externs.length) {
      console.log(
        `  Externs (vs ${tsLabel}):  MATCH signatures, DIFF count  UdonSharp=${us.externs.length}  ${tsLabel}=${ts.externs.length}`,
      );
    } else {
      console.log(
        `  Externs (vs ${tsLabel}):  MATCH (${us.externs.length} unique signatures)`,
      );
    }
  } else {
    console.log(`  Externs (vs ${tsLabel}):  DIFF`);
    for (const sig of externsDiff.onlyInA)
      console.log(`    + only UdonSharp: ${sig}`);
    for (const sig of externsDiff.onlyInB)
      console.log(`    + only ${tsLabel}:      ${sig}`);
    if (externsDiff.both.length > 0)
      console.log(`    = shared: ${externsDiff.both.length} signatures`);
  }

  // Data section diff (by type only)
  const usTypes = [...new Set(us.variables.map((v) => v.type))].sort();
  const tsTypes = [...new Set(ts.variables.map((v) => v.type))].sort();
  const typesDiff = setDiff(usTypes, tsTypes);
  if (typesDiff.onlyInA.length === 0 && typesDiff.onlyInB.length === 0) {
    if (us.variables.length !== ts.variables.length) {
      console.log(
        `  Data vars (vs ${tsLabel}): MATCH types, DIFF count  UdonSharp=${us.variables.length}  ${tsLabel}=${ts.variables.length}`,
      );
    } else {
      console.log(
        `  Data vars (vs ${tsLabel}): MATCH (${us.variables.length} vars, same types)`,
      );
    }
  } else {
    console.log(
      `  Data vars (vs ${tsLabel}): DIFF  UdonSharp=${us.variables.length}  ${tsLabel}=${ts.variables.length}`,
    );
    if (typesDiff.onlyInA.length > 0)
      console.log(
        `    + only UdonSharp types: ${typesDiff.onlyInA.join(", ")}`,
      );
    if (typesDiff.onlyInB.length > 0)
      console.log(`    + only ${tsLabel} types: ${typesDiff.onlyInB.join(", ")}`);
  }

  // Code size
  const instrDelta = ts.instructionCount - us.instructionCount;
  const instrLabel =
    instrDelta === 0
      ? "SAME"
      : instrDelta > 0
        ? `${tsLabel} +${instrDelta} more`
        : `${tsLabel} ${instrDelta} fewer`;
  console.log(
    `  Code size (vs ${tsLabel}): UdonSharp=${us.instructionCount}  ${tsLabel}=${ts.instructionCount}  (${instrLabel})`,
  );

  // Opcode sequence diff
  const opcodesDiff = setDiff(
    [...new Set(us.opcodes)],
    [...new Set(ts.opcodes)],
  );
  if (opcodesDiff.onlyInA.length === 0 && opcodesDiff.onlyInB.length === 0) {
    console.log(
      `  Opcodes (vs ${tsLabel}):  MATCH (same instruction types used)`,
    );
  } else {
    if (opcodesDiff.onlyInA.length > 0)
      console.log(
        `  Opcodes (vs ${tsLabel}):  only UdonSharp uses: ${opcodesDiff.onlyInA.join(", ")}`,
      );
    if (opcodesDiff.onlyInB.length > 0)
      console.log(
        `  Opcodes (vs ${tsLabel}):  only ${tsLabel} uses: ${opcodesDiff.onlyInB.join(", ")}`,
      );
  }
}

function printReport(reports: CaseReport[]) {
  const SEP = "─".repeat(72);
  console.log(`\n${"═".repeat(72)}`);
  console.log(
    "  UASM Comparison Report: UdonSharp vs TASM (baseline) vs TASM (optimized)",
  );
  console.log(`${"═".repeat(72)}\n`);

  for (const r of reports) {
    console.log(`${SEP}`);
    console.log(`Case: ${r.name}`);
    console.log(SEP);

    if (r.udonSharpError) {
      console.log(`  [UdonSharp]       ERROR: ${r.udonSharpError}`);
    }
    if (r.tasmError) {
      console.log(`  [TASM]            ERROR: ${r.tasmError}`);
    }
    if (r.tasmOptimizedError) {
      console.log(`  [TASM optimized]  ERROR: ${r.tasmOptimizedError}`);
    }

    const us = r.udonSharpUasm;
    const ts = r.tasmUasm;
    const tsOpt = r.tasmOptimizedUasm;

    if (us) console.log(formatMetrics("UdonSharp      ", us));
    if (ts) console.log(formatMetrics("TASM           ", ts));
    if (tsOpt) console.log(formatMetrics("TASM optimized ", tsOpt));

    // Optimization delta (baseline vs optimized)
    if (ts && tsOpt) {
      const varsDelta = tsOpt.variables.length - ts.variables.length;
      const instrDelta = tsOpt.instructionCount - ts.instructionCount;
      const externsDelta = tsOpt.externs.length - ts.externs.length;
      console.log(
        `  [Optimization effect] vars: ${varsDelta >= 0 ? "+" : ""}${varsDelta}  instructions: ${instrDelta >= 0 ? "+" : ""}${instrDelta}  externs: ${externsDelta >= 0 ? "+" : ""}${externsDelta}`,
      );
    }

    // Compare UdonSharp vs TASM baseline
    if (us && ts) {
      console.log();
      printPairDiff("vs baseline", us, ts, "TASM");
    }

    // Compare UdonSharp vs TASM optimized
    if (us && tsOpt) {
      console.log();
      printPairDiff("vs optimized", us, tsOpt, "TASM-opt");
    }

    if (!us && !ts && !tsOpt) {
      console.log("  (no output from any side)\n");
      continue;
    }

    console.log();
  }

  console.log(`${"═".repeat(72)}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const cases = discoverTestCases();
if (cases.length === 0) {
  console.log("No test cases found in tests/uasm/sample/");
  process.exit(0);
}

console.log(
  `Found ${cases.length} test case(s): ${cases.map((c) => c.name).join(", ")}`,
);

// UdonSharp compilation (Unity required)
let udonSharpUasms = new Map<string, Map<string, string>>();
let udonSharpErrors = new Map<string, Map<string, string>>();
if (UNITY_EDITOR_PATH) {
  const inputDir = path.join(UNITY_PROJECT_PATH, "UdonSharpInput");
  const outputDir = path.join(UNITY_PROJECT_PATH, "UdonSharpOutput");

  for (const dir of [inputDir, outputDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  try {
    const result = runUdonSharpCompiler(cases, inputDir, outputDir);
    udonSharpUasms = result.uasms;
    udonSharpErrors = result.errors;
    const uasmCount = [...udonSharpUasms.values()].reduce(
      (n, m) => n + m.size,
      0,
    );
    console.log(`UdonSharp compiled ${uasmCount} UASM(s)`);
  } catch (err) {
    console.error(`UdonSharp compilation failed: ${err}`);
  } finally {
    for (const dir of [inputDir, outputDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
} else {
  console.log(
    "UNITY_EDITOR_PATH not set — skipping UdonSharp compilation. Set it to enable comparison.",
  );
}

// TS transpilation (baseline + optimized)
console.log("Transpiling TypeScript (baseline)...");
const tasmResult = transpileTs(cases, false);
const tasmUasms = tasmResult.uasms;
const tasmErrors = tasmResult.errors;

console.log("Transpiling TypeScript (optimized)...");
const tasmOptResult = transpileTs(cases, true);
const tasmOptUasms = tasmOptResult.uasms;
const tasmOptErrors = tasmOptResult.errors;

// Build reports
function getUsError(
  usText: string | null,
  errMap: Map<string, string> | undefined,
  className?: string,
): string | null {
  if (usText !== null) return null;
  if (!UNITY_EDITOR_PATH) return null;
  if (!errMap) return "no compile result entry";
  const err = className ? errMap.get(className) : errMap.values().next().value;
  return err ?? "UASM not generated";
}

function getTsError(
  tsText: string | null,
  caseError: string | undefined,
): string | null {
  if (tsText !== null) return null;
  return caseError ?? "UASM not generated";
}

const reports: CaseReport[] = cases.flatMap((tc) => {
  const usMap = udonSharpUasms.get(tc.name) ?? new Map<string, string>();
  const tsMap = tasmUasms.get(tc.name) ?? new Map<string, string>();
  const tsOptMap = tasmOptUasms.get(tc.name) ?? new Map<string, string>();
  const usErrMap = udonSharpErrors.get(tc.name);
  const tsErr = tasmErrors.get(tc.name);
  const tsOptErr = tasmOptErrors.get(tc.name);

  // Collect all class names from results, errors, and declared files
  const allClassNames = new Set([
    ...usMap.keys(),
    ...tsMap.keys(),
    ...tsOptMap.keys(),
    ...(usErrMap?.keys() ?? []),
  ]);

  if (allClassNames.size <= 1) {
    // Single-class case (or no output from either side)
    const usClassName =
      usMap.size > 0 ? (usMap.keys().next().value ?? null) : null;
    const tsClassName =
      tsMap.size > 0 ? (tsMap.keys().next().value ?? null) : null;
    const tsOptClassName =
      tsOptMap.size > 0 ? (tsOptMap.keys().next().value ?? null) : null;
    const usText = usClassName ? (usMap.get(usClassName) ?? null) : null;
    const tsText = tsClassName ? (tsMap.get(tsClassName) ?? null) : null;
    const tsOptText = tsOptClassName
      ? (tsOptMap.get(tsOptClassName) ?? null)
      : null;
    return {
      name: tc.name,
      udonSharpUasm: usText ? parseUasm(usText) : null,
      tasmUasm: tsText ? parseUasm(tsText) : null,
      tasmOptimizedUasm: tsOptText ? parseUasm(tsOptText) : null,
      udonSharpError: getUsError(usText, usErrMap),
      tasmError: getTsError(tsText, tsErr),
      tasmOptimizedError: getTsError(tsOptText, tsOptErr),
    };
  }

  // Multi-class case: one report per className, matching both sides
  return [...allClassNames].map((className) => {
    const usText = usMap.get(className) ?? null;
    const tsText = tsMap.get(className) ?? null;
    const tsOptText = tsOptMap.get(className) ?? null;
    return {
      name: `${tc.name}/${className}`,
      udonSharpUasm: usText ? parseUasm(usText) : null,
      tasmUasm: tsText ? parseUasm(tsText) : null,
      tasmOptimizedUasm: tsOptText ? parseUasm(tsOptText) : null,
      udonSharpError: getUsError(usText, usErrMap, className),
      tasmError: getTsError(tsText, tsErr),
      tasmOptimizedError: getTsError(tsOptText, tsOptErr),
    };
  });
});

printReport(reports);

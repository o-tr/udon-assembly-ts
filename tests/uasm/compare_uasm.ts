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
  udonSharpError: string | null;
  tasmError: string | null;
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
          .filter((f) => f.endsWith(".ts"))
          .map((f) => path.join(sampleDir, f)),
      };
    })
    .filter((tc) => tc.tsFiles.length > 0);
}

// ─── UdonSharp compilation ────────────────────────────────────────────────────

interface CompileResultEntry {
  name: string;
  className: string;
  uasmFile: string;
  error: string;
}

function runUdonSharpCompiler(
  cases: TestCase[],
  inputDir: string,
  outputDir: string,
): Map<string, Map<string, string>> {
  const uasmByName = new Map<string, Map<string, string>>();
  const casesWithCs = cases.filter((c) => c.csFiles.length > 0);
  if (casesWithCs.length === 0) return uasmByName;

  // Write manifest (prefix filenames with case name to avoid collisions)
  const sources = casesWithCs.flatMap((tc) =>
    tc.csFiles.map((f) => ({
      name: tc.name,
      className: path.basename(f, ".cs"),
      csFile: `${tc.name}_${path.basename(f)}`,
    })),
  );
  writeFileSync(
    path.join(inputDir, "compile_manifest.json"),
    JSON.stringify({ sources }, null, 2),
    "utf-8",
  );

  // Copy .cs files to the manifest input dir (prefixed to avoid collisions)
  for (const tc of casesWithCs) {
    for (const csFile of tc.csFiles) {
      copyFileSync(
        csFile,
        path.join(inputDir, `${tc.name}_${path.basename(csFile)}`),
      );
    }
  }

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
  const seenBaseNames = new Set<string>();
  for (const tc of casesWithCs) {
    for (const csFile of tc.csFiles) {
      const baseName = path.basename(csFile);
      if (seenBaseNames.has(baseName)) {
        console.warn(
          `  [UdonSharp] WARNING: duplicate filename ${baseName} (from ${tc.name}), overwriting previous`,
        );
      }
      seenBaseNames.add(baseName);
      copyFileSync(csFile, path.join(assetsInputDir, baseName));
    }
  }

  // Run Unity batch mode
  const logFile = path.join(tmpdir(), `uasm-compare-${Date.now()}.log`);
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
      timeout: 300_000,
    });
  } catch (err: unknown) {
    const spawnError = err as NodeJS.ErrnoException & { status?: number };
    if (spawnError.code !== undefined && spawnError.status == null) throw err;
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

  try {
    rmSync(logFile, { force: true });
  } catch {
    /* ignore */
  }

  return uasmByName;
}

// ─── TS transpilation ─────────────────────────────────────────────────────────

function transpileTs(cases: TestCase[]): Map<string, Map<string, string>> {
  // Returns: caseName -> (className -> uasmText)
  const result = new Map<string, Map<string, string>>();

  const transpiler = new BatchTranspiler();

  for (const tc of cases) {
    if (tc.tsFiles.length === 0) continue;
    const tempDir = path.join(
      tmpdir(),
      `uasm-compare-ts-${Date.now()}-${tc.name}`,
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
      console.error(`  [TASM] ${tc.name}: transpilation error: ${err}`);
      result.set(tc.name, new Map());
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return result;
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

function printReport(reports: CaseReport[]) {
  const SEP = "─".repeat(60);
  console.log(`\n${"═".repeat(60)}`);
  console.log("  UASM Comparison Report: UdonSharp vs udon-assembly-ts");
  console.log(`${"═".repeat(60)}\n`);

  for (const r of reports) {
    console.log(`${SEP}`);
    console.log(`Case: ${r.name}`);
    console.log(SEP);

    if (r.udonSharpError) {
      console.log(`  [UdonSharp] ERROR: ${r.udonSharpError}`);
    }
    if (r.tasmError) {
      console.log(`  [TASM]      ERROR: ${r.tasmError}`);
    }

    const us = r.udonSharpUasm;
    const ts = r.tasmUasm;

    if (us) {
      console.log(
        `  [UdonSharp] vars=${us.variables.length}  instructions=${us.instructionCount}  externs=${us.externs.length}  exports=${us.exports.length}`,
      );
    }
    if (ts) {
      console.log(
        `  [TASM]      vars=${ts.variables.length}  instructions=${ts.instructionCount}  externs=${ts.externs.length}  exports=${ts.exports.length}`,
      );
    }

    if (!us || !ts) {
      console.log("  (skipping diff — one side missing)\n");
      continue;
    }

    // Sync mode
    if (us.syncMode || ts.syncMode) {
      if (us.syncMode === ts.syncMode) {
        console.log(`  SyncMode: MATCH (${us.syncMode})`);
      } else {
        console.log(
          `  SyncMode: DIFF  UdonSharp=${us.syncMode ?? "(none)"}  TASM=${ts.syncMode ?? "(none)"}`,
        );
      }
    }

    // Exports diff
    const exportsDiff = setDiff(us.exports, ts.exports);
    if (exportsDiff.onlyInA.length === 0 && exportsDiff.onlyInB.length === 0) {
      console.log(`  Exports:  MATCH (${us.exports.join(", ")})`);
    } else {
      console.log(
        `  Exports:  DIFF  only-UdonSharp=[${exportsDiff.onlyInA.join(", ")}]  only-TASM=[${exportsDiff.onlyInB.join(", ")}]`,
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
          `  Externs:  MATCH signatures, DIFF count  UdonSharp=${us.externs.length}  TASM=${ts.externs.length}`,
        );
      } else {
        console.log(
          `  Externs:  MATCH (${us.externs.length} unique signatures)`,
        );
      }
    } else {
      console.log("  Externs:  DIFF");
      for (const sig of externsDiff.onlyInA)
        console.log(`    + only UdonSharp: ${sig}`);
      for (const sig of externsDiff.onlyInB)
        console.log(`    + only TASM:      ${sig}`);
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
          `  Data vars: MATCH types, DIFF count  UdonSharp=${us.variables.length}  TASM=${ts.variables.length}`,
        );
      } else {
        console.log(
          `  Data vars: MATCH (${us.variables.length} vars, same types)`,
        );
      }
    } else {
      console.log(
        `  Data vars: DIFF  UdonSharp=${us.variables.length}  TASM=${ts.variables.length}`,
      );
      if (typesDiff.onlyInA.length > 0)
        console.log(
          `    + only UdonSharp types: ${typesDiff.onlyInA.join(", ")}`,
        );
      if (typesDiff.onlyInB.length > 0)
        console.log(`    + only TASM types: ${typesDiff.onlyInB.join(", ")}`);
    }

    // Code size
    const instrDelta = ts.instructionCount - us.instructionCount;
    const instrLabel =
      instrDelta === 0
        ? "SAME"
        : instrDelta > 0
          ? `TASM +${instrDelta} more`
          : `TASM ${instrDelta} fewer`;
    console.log(
      `  Code size: UdonSharp=${us.instructionCount}  TASM=${ts.instructionCount}  (${instrLabel})`,
    );

    // Opcode sequence diff
    const opcodesDiff = setDiff(
      [...new Set(us.opcodes)],
      [...new Set(ts.opcodes)],
    );
    if (opcodesDiff.onlyInA.length === 0 && opcodesDiff.onlyInB.length === 0) {
      console.log("  Opcodes:  MATCH (same instruction types used)");
    } else {
      if (opcodesDiff.onlyInA.length > 0)
        console.log(
          `  Opcodes:  only UdonSharp uses: ${opcodesDiff.onlyInA.join(", ")}`,
        );
      if (opcodesDiff.onlyInB.length > 0)
        console.log(
          `  Opcodes:  only TASM uses: ${opcodesDiff.onlyInB.join(", ")}`,
        );
    }

    console.log();
  }

  console.log(`${"═".repeat(60)}\n`);
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
if (UNITY_EDITOR_PATH) {
  const inputDir = path.join(UNITY_PROJECT_PATH, "UdonSharpInput");
  const outputDir = path.join(UNITY_PROJECT_PATH, "UdonSharpOutput");

  for (const dir of [inputDir, outputDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  try {
    udonSharpUasms = runUdonSharpCompiler(cases, inputDir, outputDir);
    console.log(`UdonSharp compiled ${udonSharpUasms.size} UASM(s)`);
  } catch (err) {
    console.error(`UdonSharp compilation failed: ${err}`);
  }
} else {
  console.log(
    "UNITY_EDITOR_PATH not set — skipping UdonSharp compilation. Set it to enable comparison.",
  );
}

// TS transpilation
console.log("Transpiling TypeScript...");
const tasmUasms = transpileTs(cases);

// Build reports
const reports: CaseReport[] = cases.flatMap((tc) => {
  const usMap = udonSharpUasms.get(tc.name) ?? new Map<string, string>();
  const tsMap = tasmUasms.get(tc.name) ?? new Map<string, string>();

  // Collect all class names from both sides
  const allClassNames = new Set([...usMap.keys(), ...tsMap.keys()]);

  if (allClassNames.size <= 1) {
    // Single-class case (or no output from either side)
    const usText = usMap.size > 0 ? [...usMap.values()][0] : null;
    const tsText = tsMap.size > 0 ? [...tsMap.values()][0] : null;
    return {
      name: tc.name,
      udonSharpUasm: usText ? parseUasm(usText) : null,
      tasmUasm: tsText ? parseUasm(tsText) : null,
      udonSharpError:
        usText === null && UNITY_EDITOR_PATH ? "UASM not generated" : null,
      tasmError: tsText === null ? "UASM not generated" : null,
    };
  }

  // Multi-class case: one report per className, matching both sides
  return [...allClassNames].map((className) => {
    const usText = usMap.get(className) ?? null;
    const tsText = tsMap.get(className) ?? null;
    return {
      name: `${tc.name}/${className}`,
      udonSharpUasm: usText ? parseUasm(usText) : null,
      tasmUasm: tsText ? parseUasm(tsText) : null,
      udonSharpError:
        usText === null && UNITY_EDITOR_PATH ? "UASM not generated" : null,
      tasmError: tsText === null ? "UASM not generated" : null,
    };
  });
});

printReport(reports);

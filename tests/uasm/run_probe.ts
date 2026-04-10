/**
 * Phase 0 investigation script: runs UdonSharpProbe in Unity batch mode
 * and reports findings about UdonSharp API availability.
 *
 * Usage:
 *   UNITY_EDITOR_PATH=<path> pnpm run probe:uasm
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UNITY_PROJECT_PATH = path.resolve(__dirname, "../vm/unity-project");
const SAMPLES_DIR = path.resolve(__dirname, "sample");
const UNITY_EDITOR_PATH = process.env.UNITY_EDITOR_PATH ?? "";

if (!UNITY_EDITOR_PATH) {
  console.error(
    "ERROR: UNITY_EDITOR_PATH environment variable is not set.\n" +
      "Example: UNITY_EDITOR_PATH=/Applications/Unity/Hub/Editor/2022.3.22f1/Unity.app/Contents/MacOS/Unity pnpm run probe:uasm",
  );
  process.exit(1);
}

// Locate a test.cs file from the sample directory
const sampleCsPath = path.join(SAMPLES_DIR, "simple", "test.cs");

const inputDir = path.join(UNITY_PROJECT_PATH, "ProbeInput");
const outputDir = path.join(UNITY_PROJECT_PATH, "ProbeOutput");

// Clean and prepare directories
for (const dir of [inputDir, outputDir]) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// Copy the test.cs to probe input
if (existsSync(sampleCsPath)) {
  copyFileSync(sampleCsPath, path.join(inputDir, "test.cs"));
  console.log(`Using test.cs from: ${sampleCsPath}`);
} else {
  console.warn(`No test.cs found at ${sampleCsPath}, skipping compilation step`);
}

// Run Unity batch mode
const logFile = path.join(tmpdir(), `uasm-probe-${Date.now()}.log`);
const unityArgs = [
  "-batchmode",
  "-nographics",
  "-projectPath",
  UNITY_PROJECT_PATH,
  "-executeMethod",
  "UdonSharpProbe.Run",
  "-probeInputDir",
  inputDir,
  "-probeOutputDir",
  outputDir,
  "-logFile",
  logFile,
  "-quit",
];

console.log(`\nRunning Unity batch mode...`);
console.log(`Unity: ${UNITY_EDITOR_PATH}`);
console.log(`Args: ${unityArgs.join(" ")}\n`);

try {
  execFileSync(UNITY_EDITOR_PATH, unityArgs, {
    timeout: 300_000, // 5 minutes
    stdio: "inherit",
  });
} catch (err: unknown) {
  const spawnError = err as NodeJS.ErrnoException & { status?: number };
  if (spawnError.code !== undefined && spawnError.status == null) {
    // Spawn failure (ENOENT, permission, etc.)
    throw err;
  }
  // Unity exited with non-zero (may still have written results)
}

// Read and display results
const resultsPath = path.join(outputDir, "probe_results.json");
if (!existsSync(resultsPath)) {
  console.error(`\nERROR: probe_results.json not found at ${resultsPath}`);
  if (existsSync(logFile)) {
    const logContent = readFileSync(logFile, "utf-8");
    const errorLines = logContent
      .split("\n")
      .filter(
        (l) =>
          l.includes("error") ||
          l.includes("Error") ||
          l.includes("[UdonSharpProbe]"),
      )
      .slice(-30)
      .join("\n");
    console.error("Unity log excerpt:\n", errorLines);
  }
  process.exit(1);
}

interface ProbeResults {
  udonSharpAvailable: boolean;
  udonSharpTypes: string[];
  compilerTypes: string[];
  udonAssemblyFieldExists: boolean;
  udonAssemblyFieldPopulated: boolean;
  udonAssemblyContent: string;
  iUdonProgramObtained: boolean;
  iUdonProgramDump: string;
  errors: string[];
  log: string[];
}

// Strip BOM if present (Unity's JsonUtility writes UTF-8 with BOM on some platforms)
const rawJson = readFileSync(resultsPath, "utf-8").replace(/^\uFEFF/, "");
const results: ProbeResults = JSON.parse(rawJson);

console.log("\n=== UdonSharp Probe Results ===\n");
console.log(`UdonSharp available:          ${results.udonSharpAvailable}`);
console.log(`UdonSharp types found:        ${results.udonSharpTypes?.length ?? 0}`);
console.log(`Compiler-related types:       ${results.compilerTypes?.length ?? 0}`);
console.log(`udonAssembly field exists:    ${results.udonAssemblyFieldExists}`);
console.log(`udonAssembly field populated: ${results.udonAssemblyFieldPopulated}`);
console.log(`IUdonProgram obtained:        ${results.iUdonProgramObtained}`);

if (results.compilerTypes?.length > 0) {
  console.log("\nCompiler-related types:");
  for (const t of results.compilerTypes) console.log(`  ${t}`);
}

if (results.udonAssemblyFieldPopulated) {
  console.log("\nudonAssembly content (first 500 chars):");
  console.log(results.udonAssemblyContent.slice(0, 500));
}

if (results.iUdonProgramDump) {
  console.log("\nIUdonProgram dump:");
  console.log(results.iUdonProgramDump);
}

if (results.errors?.length > 0) {
  console.log("\nErrors:");
  for (const e of results.errors) console.log(`  ERROR: ${e}`);
}

console.log("\nDetailed log:");
for (const line of results.log ?? []) console.log(`  ${line}`);

// Summary recommendation
console.log("\n=== Recommendation ===");
if (results.udonAssemblyFieldPopulated) {
  console.log("✓ Phase 1A: Use udonAssembly field reading approach");
} else if (results.iUdonProgramObtained) {
  console.log("→ Phase 1B: Implement IUdonProgram disassembler");
  console.log("  IUdonProgram was obtained — design disassembler based on the dump above");
} else if (!results.udonSharpAvailable) {
  console.log("✗ UdonSharp not available — check SDK installation and asmdef references");
} else {
  console.log("? UdonSharp is available but UASM extraction path is unclear");
  console.log("  Review the log above and check compiler type methods");
}

// Cleanup log file
try {
  rmSync(logFile, { force: true });
} catch { /* ignore */ }

console.log(`\nFull results saved to: ${resultsPath}`);

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../src/transpiler/index.js";
import {
  type JsRuntimeResult,
  runAllTestCasesInJs,
} from "./js_runtime_runner.js";
import { VM_TEST_CASES } from "./vm_test_definitions.js";

const UNITY_EDITOR_PATH: string = process.env.UNITY_EDITOR_PATH ?? "";
const UNITY_PROJECT_PATH = path.resolve(import.meta.dirname, "unity-project");

const shouldRun = !!UNITY_EDITOR_PATH;

interface TestResultEntry {
  name: string;
  passed: boolean;
  capturedLogs: string[];
  expectedLogs: string[];
  error: string;
}

interface TestResultsJson {
  results: TestResultEntry[];
  summary: { total: number; passed: number; failed: number };
}

describe.skipIf(!shouldRun)("UASM VM Runtime Tests", () => {
  const inputDir = path.join(UNITY_PROJECT_PATH, "TestInput");
  const outputDir = path.join(UNITY_PROJECT_PATH, "TestResults");
  const casesDir = path.resolve(import.meta.dirname, "cases");

  const testResults: Map<string, TestResultEntry> = new Map();
  const jsRuntimeResults: Map<string, JsRuntimeResult> = new Map();
  /** Resolved expected logs per test case, populated once in beforeAll. */
  const resolvedExpectedLogs: Map<string, string[]> = new Map();

  beforeAll(async () => {
    // Step 1: Run all test cases in JS runtime to generate expected logs
    const jsMap = await runAllTestCasesInJs(VM_TEST_CASES);
    jsRuntimeResults.clear();
    for (const [k, v] of jsMap) jsRuntimeResults.set(k, v);

    // Step 2: Clean I/O directories
    if (existsSync(inputDir))
      rmSync(inputDir, { recursive: true, force: true });
    if (existsSync(outputDir))
      rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(inputDir, { recursive: true });

    // Step 3: Transpile each test case and write .uasm
    const transpiler = new TypeScriptToUdonTranspiler();
    const testDefinitions: {
      tests: Array<{
        name: string;
        uasmFile: string;
        entryPoint: string;
        expectedLogs: string[];
        expectError: boolean;
      }>;
    } = { tests: [] };

    for (const testCase of VM_TEST_CASES) {
      let result: { uasm: string };
      try {
        const sourceFile = path.join(casesDir, testCase.sourceFile);
        const source = readFileSync(sourceFile, "utf-8");
        result = transpiler.transpile(source, {
          optimize: testCase.optimize,
        });
      } catch (err) {
        throw new Error(
          `Transpilation failed for "${testCase.name}" (${testCase.sourceFile}): ${err}`,
        );
      }
      const uasmFileName = `${testCase.name}.uasm`;
      const uasmPath = path.join(inputDir, uasmFileName);
      writeFileSync(uasmPath, result.uasm, "utf-8");

      if (testCase.requiredExterns && testCase.requiredExterns.length > 0) {
        const missing = testCase.requiredExterns.filter(
          (sig) => !result.uasm.includes(sig),
        );
        if (missing.length > 0) {
          throw new Error(
            `Generated UASM for "${testCase.name}" is missing required extern signatures: ${missing.join(", ")}`,
          );
        }
      }
      if (testCase.disallowedExterns && testCase.disallowedExterns.length > 0) {
        const disallowed = testCase.disallowedExterns.filter((sig) =>
          result.uasm.includes(sig),
        );
        if (disallowed.length > 0) {
          throw new Error(
            `Generated UASM for "${testCase.name}" contains disallowed extern signatures: ${disallowed.join(", ")}`,
          );
        }
      }

      // Resolve expected logs once here and cache for use in it() callbacks.
      // For expectError cases we don't need expected logs from the JS runtime.
      const expectedLogs = testCase.expectError
        ? (testCase.expectedLogs ?? [])
        : resolveExpectedLogs(testCase.name, testCase.expectedLogs);
      resolvedExpectedLogs.set(testCase.name, expectedLogs);

      testDefinitions.tests.push({
        name: testCase.name,
        uasmFile: uasmFileName,
        entryPoint: testCase.entryPoint ?? "_start",
        expectedLogs,
        expectError: testCase.expectError ?? false,
      });
    }

    // Step 4: Write test definitions JSON
    writeFileSync(
      path.join(inputDir, "test_definitions.json"),
      JSON.stringify(testDefinitions, null, 2),
      "utf-8",
    );

    // Step 5: Run Unity in batch mode
    const logFile = path.join(tmpdir(), `uasm-vm-test-${Date.now()}.log`);
    const unityArgs = [
      "-batchmode",
      "-nographics",
      "-projectPath",
      UNITY_PROJECT_PATH,
      "-executeMethod",
      "UasmTestRunner.Run",
      "-uasmTestInputDir",
      inputDir,
      "-uasmTestOutputDir",
      outputDir,
      "-logFile",
      logFile,
      "-quit",
    ];

    try {
      execFileSync(UNITY_EDITOR_PATH, unityArgs, {
        timeout: 3_600_000,
        stdio: "inherit",
      });
    } catch (err: unknown) {
      // Unity exits with code 1 when tests fail — check results file below.
      // Re-throw launch failures (ENOENT, permission, timeout, etc.)
      const spawnError = err as NodeJS.ErrnoException & { status?: number };
      if (spawnError.code !== undefined && spawnError.status == null) {
        throw err;
      }
    }

    // Step 6: Read results
    const resultsPath = path.join(outputDir, "test_results.json");
    if (!existsSync(resultsPath)) {
      // Read Unity log for diagnostics
      if (existsSync(logFile)) {
        const logContent = readFileSync(logFile, "utf-8");
        const errorLines = logContent
          .split("\n")
          .filter(
            (l) =>
              l.includes("error") ||
              l.includes("Error") ||
              l.includes("[UasmTestRunner]"),
          )
          .slice(-20)
          .join("\n");
        throw new Error(
          `Unity test results not found at ${resultsPath}. Unity may have crashed.\nLog excerpt:\n${errorLines}`,
        );
      }
      throw new Error(
        `Unity test results not found at ${resultsPath}. Unity may have crashed.`,
      );
    }

    const rawResults: TestResultsJson = JSON.parse(
      readFileSync(resultsPath, "utf-8"),
    );
    testResults.clear();
    for (const result of rawResults.results) {
      if (testResults.has(result.name)) {
        throw new Error(`Duplicate test result name: "${result.name}"`);
      }
      testResults.set(result.name, result);
    }

    // Clean up temp log file
    try {
      rmSync(logFile, { force: true });
    } catch {
      /* ignore */
    }
  }, 3_600_000); // 10 minute timeout for beforeAll

  /**
   * Resolve expected logs for a test case.
   * Uses hardcoded expectedLogs if provided, otherwise falls back to JS runtime output.
   */
  function resolveExpectedLogs(
    name: string,
    hardcodedLogs?: string[],
  ): string[] {
    if (hardcodedLogs) return hardcodedLogs;

    const jsResult = jsRuntimeResults.get(name);
    if (!jsResult) {
      throw new Error(
        `No JS runtime result for "${name}" and no hardcoded expectedLogs`,
      );
    }
    if (jsResult.error) {
      throw new Error(
        `JS runtime failed for "${name}": ${jsResult.error}. ` +
          `Provide hardcoded expectedLogs or fix the JS runtime error.`,
      );
    }
    return jsResult.logs;
  }

  // Generate individual vitest assertions per test case
  for (const testCase of VM_TEST_CASES) {
    const knownFailSuffix = testCase.knownFail
      ? testCase.knownFailReason
        ? ` [KNOWN FAIL: ${testCase.knownFailReason}]`
        : " [KNOWN FAIL]"
      : "";

    it(`VM: ${testCase.name}${knownFailSuffix}`, () => {
      const result = testResults.get(testCase.name);
      if (!result) {
        throw new Error(`No result found for test "${testCase.name}"`);
      }

      const expectedLogs = resolvedExpectedLogs.get(testCase.name) ?? [];

      if (testCase.knownFail) {
        expect(result.passed).toBe(false);
        return;
      }

      if (!result.passed) {
        throw new Error(
          `VM test "${testCase.name}" failed:\n` +
            `  Error: ${result.error}\n` +
            `  Expected logs: ${JSON.stringify(expectedLogs)}\n` +
            `  Captured logs: ${JSON.stringify(result.capturedLogs)}`,
        );
      }

      expect(result.capturedLogs).toEqual(expectedLogs);
    });
  }
});

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
import { VM_TEST_CASES } from "./vm_test_definitions.js";

const UNITY_EDITOR_PATH = process.env.UNITY_EDITOR_PATH;
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

  let testResults: Map<string, TestResultEntry> = new Map();

  beforeAll(() => {
    // Clean I/O directories
    if (existsSync(inputDir)) rmSync(inputDir, { recursive: true, force: true });
    if (existsSync(outputDir))
      rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(inputDir, { recursive: true });

    // Transpile each test case and write .uasm
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
      const sourceFile = path.join(casesDir, testCase.sourceFile);
      const source = readFileSync(sourceFile, "utf-8");
      const result = transpiler.transpile(source);
      const uasmFileName = `${testCase.name}.uasm`;
      writeFileSync(path.join(inputDir, uasmFileName), result.uasm, "utf-8");

      testDefinitions.tests.push({
        name: testCase.name,
        uasmFile: uasmFileName,
        entryPoint: testCase.entryPoint,
        expectedLogs: testCase.expectedLogs,
        expectError: testCase.expectError ?? false,
      });
    }

    // Write test definitions JSON
    writeFileSync(
      path.join(inputDir, "test_definitions.json"),
      JSON.stringify(testDefinitions, null, 2),
      "utf-8",
    );

    // Run Unity in batch mode
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
      execFileSync(UNITY_EDITOR_PATH!, unityArgs, {
        timeout: 300_000,
        stdio: "inherit",
        encoding: "utf-8",
      });
    } catch {
      // Unity exits with code 1 if any test fails; check results file
    }

    // Read results
    const resultsPath = path.join(outputDir, "test_results.json");
    if (!existsSync(resultsPath)) {
      // Read Unity log for diagnostics
      let logContent = "";
      if (existsSync(logFile)) {
        logContent = readFileSync(logFile, "utf-8");
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
    testResults = new Map();
    for (const result of rawResults.results) {
      testResults.set(result.name, result);
    }
  }, 600_000); // 10 minute timeout for beforeAll

  // Generate individual vitest assertions per test case
  for (const testCase of VM_TEST_CASES) {
    it(`VM: ${testCase.name}`, () => {
      const result = testResults.get(testCase.name);
      expect(
        result,
        `No result found for test "${testCase.name}"`,
      ).toBeDefined();

      if (!result!.passed) {
        throw new Error(
          `VM test "${testCase.name}" failed:\n` +
            `  Error: ${result!.error}\n` +
            `  Expected logs: ${JSON.stringify(testCase.expectedLogs)}\n` +
            `  Captured logs: ${JSON.stringify(result!.capturedLogs)}`,
        );
      }

      expect(result!.capturedLogs).toEqual(testCase.expectedLogs);
    });
  }
});

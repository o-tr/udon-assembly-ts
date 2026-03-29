/**
 * JS Runtime Runner — shared logic for executing test case TypeScript files
 * in Node.js and capturing Debug.Log output.
 *
 * Used by both:
 * - js_runtime_test.test.ts (standalone JS runtime equivalence tests)
 * - vm_test.test.ts (to dynamically generate expectedLogs for VM comparison)
 */
import path from "node:path";
import { clearCapturedLogs, getCapturedLogs } from "./runtime-stubs/capture.js";
import { UdonSharpBehaviour } from "./runtime-stubs/UdonSharpBehaviour.js";
import type { VmTestCase } from "./vm_test_definitions.js";

const casesDir = path.resolve(import.meta.dirname, "cases");

/**
 * Map VM entry point symbols to method names on the UdonSharpBehaviour class.
 * The default entry point "_start" maps to the Start() method.
 */
function entryPointToMethodName(entryPoint: string): string {
  if (entryPoint === "_start") return "Start";
  // Custom entry points are not supported in JS runtime
  return entryPoint;
}

export interface JsRuntimeResult {
  name: string;
  logs: string[];
  error?: string;
}

/**
 * Execute a single test case in the JS runtime and return captured logs.
 */
export async function runTestCaseInJs(
  testCase: VmTestCase,
): Promise<JsRuntimeResult> {
  clearCapturedLogs();

  const methodName = entryPointToMethodName(testCase.entryPoint ?? "_start");

  try {
    const modulePath = path.join(casesDir, testCase.sourceFile);
    const mod = await import(
      /* @vite-ignore */ `${modulePath}?t=${Date.now()}`
    );

    const ExportedClass = findUdonClass(mod);
    if (!ExportedClass) {
      return {
        name: testCase.name,
        logs: [],
        error: `No UdonSharpBehaviour subclass found in ${testCase.sourceFile}`,
      };
    }

    const instance = new ExportedClass();
    const method = (instance as unknown as Record<string, unknown>)[methodName];
    if (typeof method !== "function") {
      return {
        name: testCase.name,
        logs: [],
        error: `Class in ${testCase.sourceFile} has no ${methodName}() method`,
      };
    }

    await method.call(instance);
    return { name: testCase.name, logs: getCapturedLogs() };
  } catch (err) {
    return {
      name: testCase.name,
      logs: getCapturedLogs(),
      error: String(err),
    };
  }
}

/**
 * Execute all test cases in the JS runtime and return a map of name → logs.
 */
export async function runAllTestCasesInJs(
  testCases: VmTestCase[],
): Promise<Map<string, JsRuntimeResult>> {
  const results = new Map<string, JsRuntimeResult>();

  for (const testCase of testCases) {
    if (testCase.expectError) {
      // Tests that expect VM errors can't produce JS runtime expected logs
      continue;
    }
    const result = await runTestCaseInJs(testCase);
    results.set(testCase.name, result);
  }

  return results;
}

/**
 * Find the first exported class that extends UdonSharpBehaviour.
 */
function findUdonClass(
  mod: Record<string, unknown>,
): (new () => UdonSharpBehaviour) | null {
  for (const key of Object.keys(mod)) {
    const value = mod[key];
    if (
      typeof value === "function" &&
      value.prototype instanceof UdonSharpBehaviour
    ) {
      return value as new () => UdonSharpBehaviour;
    }
  }
  return null;
}

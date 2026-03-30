/**
 * JS Runtime Runner — shared logic for executing test case TypeScript files
 * in Node.js and capturing Debug.Log output.
 *
 * Used by both:
 * - js_runtime_test.test.ts (standalone JS runtime equivalence tests)
 * - vm_test.test.ts (to dynamically generate expectedLogs for VM comparison)
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  beginCapture,
  endCapture,
  getCapturedLogs,
} from "./runtime-stubs/capture.js";
import { UdonSharpBehaviour } from "./runtime-stubs/UdonSharpBehaviour.js";
import type { VmTestCase } from "./vm_test_definitions.js";

const casesDir = path.resolve(import.meta.dirname, "cases");

/**
 * Map a Udon VM entry point symbol to the corresponding method name on
 * the UdonSharpBehaviour class.
 *
 * The convention is to strip the leading underscore and capitalise the
 * first letter: "_start" → "Start", "_update" → "Update".
 */
function entryPointToMethodName(entryPoint: string): string {
  const raw = entryPoint.replace(/^_/, "");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
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
  const methodName = entryPointToMethodName(testCase.entryPoint ?? "_start");

  try {
    // beginCapture() throws if a concurrent runTestCaseInJs() is already running.
    // It must be inside the try so that finally always calls endCapture(),
    // preventing isCapturing from staying true permanently after an error.
    beginCapture();
    // Use a file URL so the import specifier is portable across platforms
    // (on Windows, absolute paths in dynamic imports require file:// URLs).
    const modulePath = path.join(casesDir, testCase.sourceFile);
    const moduleUrl = new URL(`?t=${Date.now()}`, pathToFileURL(modulePath));
    const mod = await import(/* @vite-ignore */ moduleUrl.href);

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
  } finally {
    // Guaranteed to run regardless of early returns or thrown errors.
    endCapture();
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
 * Find the single exported class that extends UdonSharpBehaviour.
 * Throws if multiple matching exports are found.
 */
function findUdonClass(
  mod: Record<string, unknown>,
): (new () => UdonSharpBehaviour) | null {
  const matches: Array<new () => UdonSharpBehaviour> = [];
  for (const key of Object.keys(mod)) {
    const value = mod[key];
    if (
      typeof value === "function" &&
      value.prototype instanceof UdonSharpBehaviour
    ) {
      matches.push(value as new () => UdonSharpBehaviour);
    }
  }
  if (matches.length > 1) {
    throw new Error(
      "Multiple UdonSharpBehaviour subclasses exported — expected exactly one.",
    );
  }
  return matches[0] ?? null;
}

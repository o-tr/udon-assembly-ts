/**
 * JS Runtime Equivalence Tests
 *
 * Executes each VM test case TypeScript file in the Node.js runtime
 * and verifies that the captured Debug.Log output matches the expected
 * values (same as the Udon VM would produce).
 *
 * This test suite runs without Unity — it validates that the JS runtime
 * stubs produce identical output to the Udon VM for all test cases.
 */
import { describe, expect, it } from "vitest";
import { runTestCaseInJs } from "./js_runtime_runner.js";
import { VM_TEST_CASES } from "./vm_test_definitions.js";

describe("JS Runtime Equivalence Tests", () => {
  for (const testCase of VM_TEST_CASES) {
    // Skip tests that expect VM/assembly errors — those can't run in JS
    if (testCase.expectError) continue;

    it(`JS: ${testCase.name}`, async () => {
      const result = await runTestCaseInJs(testCase);

      if (result.error) {
        throw new Error(
          `JS runtime error for "${testCase.name}": ${result.error}`,
        );
      }

      if (testCase.expectedLogs) {
        expect(result.logs).toEqual(testCase.expectedLogs);
      }
    });
  }
});

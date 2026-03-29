/**
 * JS Runtime Equivalence Tests
 *
 * Executes each VM test case TypeScript file in the Node.js runtime
 * and verifies that the captured Debug.Log output matches a snapshot.
 *
 * This provides regression coverage for the JS runtime stubs:
 * if a stub changes its output, the snapshot diff will catch it.
 */
import { describe, expect, it } from "vitest";
import { runTestCaseInJs } from "./js_runtime_runner.js";
import { VM_TEST_CASES } from "./vm_test_definitions.js";

describe.sequential("JS Runtime Equivalence Tests", () => {
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

      // When hardcoded expectedLogs exist, validate against them
      if (testCase.expectedLogs) {
        expect(result.logs).toEqual(testCase.expectedLogs);
      }

      // Always snapshot to catch regressions in runtime stubs
      expect(result.logs).toMatchSnapshot();
    });
  }
});

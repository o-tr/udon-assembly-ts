export interface VmTestCase {
  /** Test case name, used as identifier */
  name: string;
  /** Relative path to TypeScript source file within tests/vm/cases/ */
  sourceFile: string;
  /** Entry point symbol in the .uasm (default: "_start", the UdonSharp Start() export) */
  entryPoint?: string;
  /** Expected Debug.Log outputs in order */
  expectedLogs: string[];
  /** If true, the test expects a VM/assembly error */
  expectError?: boolean;
}

// Note: numeric Debug.Log output format depends on Udon's boxing behavior.
// TypeScript `number` maps to SystemSingle (float).
// C# float.ToString() omits decimal for whole numbers: 15f -> "15", 3.14f -> "3.14".
// If the VM output format differs, adjust expectedLogs accordingly.

export const VM_TEST_CASES: VmTestCase[] = [
  {
    name: "simple_log",
    sourceFile: "simple_log.ts",

    expectedLogs: ["hello udon-sharp"],
  },
  {
    name: "arithmetic",
    sourceFile: "arithmetic.ts",

    expectedLogs: ["15", "5", "50", "2"],
  },
  {
    name: "control_flow",
    sourceFile: "control_flow.ts",

    expectedLogs: ["greater", "0", "1", "2", "10", "11", "12"],
  },
  {
    name: "string_ops",
    sourceFile: "string_ops.ts",

    expectedLogs: ["Hello World"],
  },
  {
    name: "method_calls",
    sourceFile: "method_calls.ts",

    expectedLogs: ["7"],
  },
];

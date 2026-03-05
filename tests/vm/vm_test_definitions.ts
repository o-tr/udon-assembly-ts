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
  // --- Inline class tests ---
  {
    name: "inline_basic",
    sourceFile: "inline_basic.ts",
    expectedLogs: ["3"],
  },
  {
    name: "inline_constructor",
    sourceFile: "inline_constructor.ts",
    expectedLogs: ["200"],
  },
  {
    name: "inline_multiple_instances",
    sourceFile: "inline_multiple_instances.ts",
    expectedLogs: ["15", "20"],
  },
  {
    name: "inline_method_chain",
    sourceFile: "inline_method_chain.ts",
    expectedLogs: ["10", "13"],
  },
  {
    name: "inline_nested",
    sourceFile: "inline_nested.ts",
    expectedLogs: ["42", "84"],
  },
  {
    name: "inline_with_params",
    sourceFile: "inline_with_params.ts",
    expectedLogs: ["42", "60"],
  },
  // --- Operator tests ---
  {
    name: "operators_arithmetic",
    sourceFile: "operators_arithmetic.ts",
    expectedLogs: ["2", "15", "12", "24", "-24"],
  },
  {
    name: "operators_comparison",
    sourceFile: "operators_comparison.ts",
    expectedLogs: ["eq", "neq", "lt", "gt", "lte", "gte", "not"],
  },
  // --- Control flow tests ---
  {
    name: "switch_case",
    sourceFile: "switch_case.ts",
    expectedLogs: ["two", "default"],
  },
  {
    name: "do_while",
    sourceFile: "do_while.ts",
    expectedLogs: ["0", "1", "2"],
  },
  {
    name: "nested_loops",
    sourceFile: "nested_loops.ts",
    expectedLogs: ["4", "10"],
  },
  // --- Expression and pattern tests ---
  {
    name: "ternary_and_shortcircuit",
    sourceFile: "ternary_and_shortcircuit.ts",
    expectedLogs: ["big", "small", "False", "True"],
  },
  {
    name: "enum_usage",
    sourceFile: "enum_usage.ts",
    expectedLogs: ["3", "is right", "right"],
  },
  {
    name: "method_patterns",
    sourceFile: "method_patterns.ts",
    expectedLogs: ["20", "30", "5", "0", "10", "9"],
  },
  {
    name: "inline_state_machine",
    sourceFile: "inline_state_machine.ts",
    expectedLogs: ["idle", "running", "done", "idle"],
  },
];

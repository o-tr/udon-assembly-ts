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
  // --- String operation tests ---
  {
    name: "string_concat_parts",
    sourceFile: "string_concat_parts.ts",
    expectedLogs: ["Hello World", "HelloWorld", "Hello"],
  },
  {
    name: "template_literal_basic",
    sourceFile: "template_literal_basic.ts",
    expectedLogs: ["Hello World", "15", "5"],
  },
  {
    name: "string_concat_basic",
    sourceFile: "string_concat_basic.ts",
    expectedLogs: ["Hello World", "HelloWorld"],
  },
  // --- Mathf tests ---
  {
    name: "mathf_basic",
    sourceFile: "mathf_basic.ts",
    expectedLogs: ["5", "3", "7", "3", "4"],
  },
  {
    name: "mathf_advanced",
    sourceFile: "mathf_advanced.ts",
    expectedLogs: ["3", "1024", "4"],
  },
  // --- Type conversion tests ---
  {
    name: "type_conversion",
    sourceFile: "type_conversion.ts",
    expectedLogs: ["3.14", "100", "-42", "True", "False"],
  },
  // --- Variable mutation & accumulation ---
  {
    name: "compound_assignment",
    sourceFile: "compound_assignment.ts",
    expectedLogs: ["15", "12", "24", "6", "2", "15"],
  },
  {
    name: "increment_decrement",
    sourceFile: "increment_decrement.ts",
    expectedLogs: ["1", "2", "1", "55", "120"],
  },
  // --- Local variables & early returns ---
  {
    name: "block_scoping",
    sourceFile: "block_scoping.ts",
    expectedLogs: ["60", "10", "Hello World", "2", "1"],
  },
  {
    name: "early_return",
    sourceFile: "early_return.ts",
    expectedLogs: ["negative", "zero", "small", "large"],
  },
  // --- Null coalescing & complex boolean ---
  {
    name: "null_coalescing",
    sourceFile: "null_coalescing.ts",
    expectedLogs: ["hello", "fallback"],
  },
  {
    name: "complex_boolean",
    sourceFile: "complex_boolean.ts",
    expectedLogs: ["True", "False", "False", "True", "True", "False"],
  },
  // --- String concat & StringBuilder ---
  {
    name: "string_concat_multi",
    sourceFile: "string_concat_multi.ts",
    expectedLogs: ["Name: Player, Score: 42", "Hello World"],
  },
  {
    name: "string_concat_chain",
    sourceFile: "string_concat_chain.ts",
    expectedLogs: ["abcdef", "x=10, y=20", "sum=30"],
  },
  // --- Method chains ---
  {
    name: "method_chain_calls",
    sourceFile: "method_chain_calls.ts",
    expectedLogs: ["14", "16", "-6"],
  },
  // --- Computation patterns ---
  {
    name: "fibonacci_iterative",
    sourceFile: "fibonacci_iterative.ts",
    expectedLogs: ["0", "1", "5", "55"],
  },
  // --- DataList & DataDictionary ---
  {
    name: "data_list",
    sourceFile: "data_list.ts",
    expectedLogs: ["added 3 items", "added 4th item"],
  },
  {
    name: "data_dictionary",
    sourceFile: "data_dictionary.ts",
    expectedLogs: ["set 2 values", "True", "False"],
  },
  // --- Object literal → DataDictionary conversion ---
  {
    name: "object_literal_basic",
    sourceFile: "object_literal_basic.ts",
    expectedLogs: ["Alice", "30", "True"],
  },
  {
    name: "object_literal_spread",
    sourceFile: "object_literal_spread.ts",
    expectedLogs: ["Alice", "30", "NYC", "3"],
  },
  {
    name: "object_literal_nested",
    sourceFile: "object_literal_nested.ts",
    expectedLogs: ["True", "hello"],
  },
  // --- Array literal → DataList conversion ---
  {
    name: "array_literal_basic",
    sourceFile: "array_literal_basic.ts",
    expectedLogs: ["3", "10", "30"],
  },
  {
    name: "array_literal_iteration",
    sourceFile: "array_literal_iteration.ts",
    expectedLogs: ["10", "20", "30", "60"],
  },
  // --- DataList / DataDictionary deep operations ---
  {
    name: "data_list_operations",
    sourceFile: "data_list_operations.ts",
    expectedLogs: ["3", "20", "True", "2", "10"],
  },
  {
    name: "data_dictionary_operations",
    sourceFile: "data_dictionary_operations.ts",
    expectedLogs: ["Alice", "2", "True", "1", "False"],
  },
  {
    name: "data_dictionary_getkeys",
    sourceFile: "data_dictionary_getkeys.ts",
    expectedLogs: ["2", "2"],
  },
  {
    name: "data_dictionary_shallow_clone",
    sourceFile: "data_dictionary_shallow_clone.ts",
    expectedLogs: ["Alice", "Alice", "Bob", "Alice"],
  },
  // --- Method inlining edge cases ---
  {
    name: "inline_cross_method_call",
    sourceFile: "inline_cross_method_call.ts",
    expectedLogs: ["15", "25"],
  },
  {
    name: "inline_multiple_returns",
    sourceFile: "inline_multiple_returns.ts",
    expectedLogs: ["negative", "zero", "positive"],
  },
  {
    name: "inline_state_read_after_write",
    sourceFile: "inline_state_read_after_write.ts",
    expectedLogs: ["5", "15", "20"],
  },
  {
    name: "inline_as_parameter",
    sourceFile: "inline_as_parameter.ts",
    expectedLogs: ["42"],
  },
  // --- Recursive functions ---
  {
    name: "recursive_factorial",
    sourceFile: "recursive_factorial.ts",
    expectedLogs: ["1", "1", "6", "120"],
  },
  {
    name: "recursive_with_locals",
    sourceFile: "recursive_with_locals.ts",
    expectedLogs: ["55"],
  },
  {
    name: "recursive_fibonacci",
    sourceFile: "recursive_fibonacci.ts",
    expectedLogs: ["0", "1", "8", "55"],
  },
  // --- For-of iteration ---
  {
    name: "for_of_data_list",
    sourceFile: "for_of_data_list.ts",
    expectedLogs: ["10", "20", "30", "60"],
  },
  {
    name: "for_of_array",
    sourceFile: "for_of_array.ts",
    expectedLogs: ["1", "2", "3", "6"],
  },
  // --- Type coercion & edge cases ---
  {
    name: "type_coercion_int_float",
    sourceFile: "type_coercion_int_float.ts",
    expectedLogs: ["3.14", "6.28", "3", "7"],
  },
  {
    name: "type_coercion_string_number",
    sourceFile: "type_coercion_string_number.ts",
    expectedLogs: ["42", "The answer is 42", "100"],
  },
  {
    name: "optional_chaining",
    sourceFile: "optional_chaining.ts",
    expectedLogs: ["hello", "fallback"],
  },
  {
    name: "try_catch_error",
    sourceFile: "try_catch_error.ts",
    expectedLogs: ["before", "caught", "after"],
  },
  {
    name: "try_catch_basic",
    sourceFile: "try_catch_basic.ts",
    expectedLogs: ["before", "after"],
  },
  {
    name: "boolean_to_string_format",
    sourceFile: "boolean_to_string_format.ts",
    expectedLogs: ["True", "False", "True", "False"],
  },
  {
    name: "negative_numbers",
    sourceFile: "negative_numbers.ts",
    expectedLogs: ["-5", "-10", "5", "-1"],
  },
  {
    name: "cast_as_expression",
    sourceFile: "cast_as_expression.ts",
    expectedLogs: ["42", "hello"],
  },
  // --- Numeric type promotion tests ---
  {
    name: "numeric_type_promotion",
    sourceFile: "numeric_type_promotion.ts",
    expectedLogs: ["13", "35", "False", "True", "3"],
  },
  {
    name: "int_arithmetic",
    sourceFile: "int_arithmetic.ts",
    expectedLogs: ["3", "1", "-3", "14", "9", "5"],
  },
  // --- Bitwise & shift operator tests ---
  {
    name: "bitwise_operators",
    sourceFile: "bitwise_operators.ts",
    expectedLogs: ["15", "255", "240", "255"],
  },
  {
    name: "shift_operators",
    sourceFile: "shift_operators.ts",
    expectedLogs: ["16", "64", "-4", "1024"],
  },
  // --- Type cast edge cases ---
  {
    name: "cast_float_to_int",
    sourceFile: "cast_float_to_int.ts",
    expectedLogs: ["3", "-3", "0", "100"],
    // Tests CastInstruction path: Single→Double→Math.Truncate→Int32
  },
  // --- Restricted type runtime init ---
  {
    name: "restricted_type_init",
    sourceFile: "restricted_type_init.ts",
    expectedLogs: ["True", "False", "True"],
  },
  // --- Switch statement advanced patterns ---
  {
    name: "switch_fallthrough",
    sourceFile: "switch_fallthrough.ts",
    expectedLogs: ["one", "two", "b-two", "c-default"],
  },
  {
    name: "switch_string",
    sourceFile: "switch_string.ts",
    expectedLogs: ["matched hello", "default"],
  },
  // --- Deep nested control flow ---
  {
    name: "nested_control_flow_deep",
    sourceFile: "nested_control_flow_deep.ts",
    expectedLogs: ["6", "3", "12"],
  },
  // --- Mixed type compound assignment ---
  {
    name: "compound_assignment_mixed",
    sourceFile: "compound_assignment_mixed.ts",
    expectedLogs: ["3", "55", "2", "7.5"],
  },
  // --- Boolean coercion in logical NOT ---
  {
    name: "boolean_coercion_not",
    sourceFile: "boolean_coercion_not.ts",
    expectedLogs: ["False", "True", "True", "correct"],
  },
  // --- Unary negation on typed integers ---
  {
    name: "unary_negation_typed",
    sourceFile: "unary_negation_typed.ts",
    expectedLogs: ["-10", "-42", "42"],
  },
  // --- Large float literal runtime parse ---
  {
    name: "large_float_literal",
    sourceFile: "large_float_literal.ts",
    expectedLogs: ["True", "True"],
  },
  // --- Complex template literals ---
  {
    name: "template_literal_complex",
    sourceFile: "template_literal_complex.ts",
    expectedLogs: ["result: 30", "Alice is True", "1-2-3"],
  },
  // --- Bug fix: increment/decrement operators ---
  {
    name: "increment_operators",
    sourceFile: "increment_operators.ts",
    expectedLogs: ["6", "5", "8", "5"],
  },
  // --- Bug fix: compound assignment operators ---
  {
    name: "compound_assignment_operators",
    sourceFile: "compound_assignment_operators.ts",
    expectedLogs: ["15", "12", "24", "6", "2", "7.5", "15"],
  },
  // --- Bug fix: Convert overload resolution ---
  {
    name: "convert_overload",
    sourceFile: "convert_overload.ts",
    expectedLogs: ["4", "42", "42"],
  },
  // --- Mixed numeric type operations ---
  {
    name: "mixed_numeric_arithmetic",
    sourceFile: "mixed_numeric_arithmetic.ts",
    expectedLogs: ["11.5", "20", "0.75", "23"],
  },
  {
    name: "mixed_numeric_comparison",
    sourceFile: "mixed_numeric_comparison.ts",
    expectedLogs: ["True", "True", "False", "True"],
  },
  {
    name: "numeric_cast_chain",
    sourceFile: "numeric_cast_chain.ts",
    expectedLogs: ["3", "3", "7", "7.5"],
  },
  // --- Multi-part string concat ---
  {
    name: "string_concat_many_parts",
    sourceFile: "string_concat_many_parts.ts",
    expectedLogs: ["abcde", "abcde", "xyzw"],
  },
  {
    name: "string_concat_mixed_types",
    sourceFile: "string_concat_mixed_types.ts",
    expectedLogs: ["val=42", "flag=True", "f=3.14", "n=42 b=True"],
  },
  // --- Array index write/read ---
  {
    name: "array_index_write_read",
    sourceFile: "array_index_write_read.ts",
    expectedLogs: ["10", "20", "99", "10", "30"],
  },
  // --- For-of destructuring & break/continue ---
  {
    name: "for_of_dict_destructure",
    sourceFile: "for_of_dict_destructure.ts",
    expectedLogs: ["2", "30"],
  },
  {
    name: "for_of_with_break",
    sourceFile: "for_of_with_break.ts",
    expectedLogs: ["1", "2", "3", "1", "3", "4"],
  },
  // --- Template literal multi-part ---
  {
    name: "template_literal_many_parts",
    sourceFile: "template_literal_many_parts.ts",
    expectedLogs: ["1-2-3", "sum=30", "test:42"],
  },
  // --- DataList set_Item ---
  {
    name: "data_list_set_item",
    sourceFile: "data_list_set_item.ts",
    expectedLogs: ["10", "20", "99", "30"],
  },
  // --- Switch expression discriminant ---
  {
    name: "switch_expression_discriminant",
    sourceFile: "switch_expression_discriminant.ts",
    expectedLogs: ["matched 5", "computed match", "1"],
  },
  {
    name: "switch_enum_advanced",
    sourceFile: "switch_enum_advanced.ts",
    expectedLogs: ["green", "not red"],
  },
  // --- Short-circuit side effects ---
  {
    name: "short_circuit_side_effects",
    sourceFile: "short_circuit_side_effects.ts",
    expectedLogs: ["check-a", "False", "check-b", "True"],
  },
  // --- Multi inline class interaction ---
  {
    name: "inline_multi_class_interaction",
    sourceFile: "inline_multi_class_interaction.ts",
    expectedLogs: ["5", "12", "5"],
  },
  {
    name: "inline_return_value_chain",
    sourceFile: "inline_return_value_chain.ts",
    expectedLogs: ["20", "26"],
  },
  // --- Field initialization ---
  {
    name: "field_init_order",
    sourceFile: "field_init_order.ts",
    expectedLogs: ["10", "default", "True", "3.14"],
  },
  // --- Null coalescing chain ---
  {
    name: "null_coalescing_chain",
    sourceFile: "null_coalescing_chain.ts",
    expectedLogs: ["first", "second", "fallback"],
  },
  // --- Null coalescing with method returns ---
  {
    name: "optional_chaining_method",
    sourceFile: "optional_chaining_method.ts",
    expectedLogs: ["hello", "was-null", "deep", "hello"],
  },
  // --- Try-catch advanced ---
  {
    name: "try_catch_nested",
    sourceFile: "try_catch_nested.ts",
    expectedLogs: [
      "outer-start",
      "inner-start",
      "inner-caught",
      "outer-continues",
      "done",
    ],
  },
  {
    name: "try_catch_finally",
    sourceFile: "try_catch_finally.ts",
    expectedLogs: ["try-ok", "finally-1", "caught-2", "finally-2", "done"],
  },
  // --- Loop break/continue ---
  {
    name: "for_loop_break_continue",
    sourceFile: "for_loop_break_continue.ts",
    expectedLogs: ["1", "3", "5", "0", "1", "0", "1"],
  },
  {
    name: "loop_variable_scoping",
    sourceFile: "loop_variable_scoping.ts",
    expectedLogs: ["0", "1", "2", "10", "11", "12"],
  },
  // --- Inline field defaults ---
  {
    name: "inline_field_defaults",
    sourceFile: "inline_field_defaults.ts",
    expectedLogs: ["5", "15", "20"],
  },
  // --- Nested ternary ---
  {
    name: "nested_ternary",
    sourceFile: "nested_ternary.ts",
    expectedLogs: ["big", "medium", "small"],
  },
  // --- Expression in call args ---
  {
    name: "expression_in_call_args",
    sourceFile: "expression_in_call_args.ts",
    expectedLogs: ["15", "10", "15"],
  },
  // --- For-of dict keys lookup ---
  {
    name: "for_of_dict_keys_lookup",
    sourceFile: "for_of_dict_keys_lookup.ts",
    expectedLogs: ["30", "2"],
  },
];

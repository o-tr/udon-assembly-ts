export interface VmTestCase {
  /** Test case name, used as identifier */
  name: string;
  /** Relative path to TypeScript source file within tests/vm/cases/ */
  sourceFile: string;
  /** Entry point symbol in the .uasm (default: "_start", the UdonSharp Start() export) */
  entryPoint?: string;
  /**
   * Expected Debug.Log outputs in order.
   *
   * Optional — when omitted, expected values are generated dynamically
   * by executing the test case in the JS runtime.
   * When provided, both JS runtime and VM tests validate against this value.
   */
  expectedLogs?: string[];
  /** If true, the test expects a VM/assembly error */
  expectError?: boolean;
  /** If true, enable TAC optimizer before code generation */
  optimize?: boolean;
  /** Required extern signatures that must appear in generated UASM */
  requiredExterns?: string[];
  /** Forbidden extern signatures that must not appear in generated UASM */
  disallowedExterns?: string[];
}

// Current transpiler policy backs TypeScript arrays with DataList in generated UASM.
// The disallowed list below enforces this policy (not a claim about VM capability).
const datalistArrayCoreExterns = [
  "VRCSDK3DataDataList.__ctor____VRCSDK3DataDataList",
  "VRCSDK3DataDataList.__get_Item__SystemInt32__VRCSDK3DataDataToken",
  "VRCSDK3DataDataList.__Add__VRCSDK3DataDataToken__SystemVoid",
  "VRCSDK3DataDataList.__get_Count__SystemInt32",
];

const datalistArrayDisallowedExterns = [
  "SystemObjectArray.__Set__SystemInt32_SystemObject__SystemVoid",
  "SystemObjectArray.__Get__SystemInt32__SystemObject",
  "SystemObjectArray.__ctor__SystemInt32__SystemObjectArray",
  "SystemArray.__Set__SystemInt32_SystemObject__SystemVoid",
  "SystemArray.__Get__SystemInt32__SystemObject",
  "SystemArray.__Copy__SystemArray_SystemInt64_SystemArray_SystemInt64_SystemInt64__SystemVoid",
  "SystemArray.__get_Length__SystemInt32",
  "SystemObjectArray.__get_Length__SystemInt32",
];

export const VM_TEST_CASES: VmTestCase[] = [
  { name: "simple_log", sourceFile: "simple_log.ts" },
  { name: "arithmetic", sourceFile: "arithmetic.ts" },
  { name: "control_flow", sourceFile: "control_flow.ts" },
  { name: "string_ops", sourceFile: "string_ops.ts" },
  { name: "method_calls", sourceFile: "method_calls.ts" },
  // --- Inline class tests ---
  { name: "inline_basic", sourceFile: "inline_basic.ts" },
  { name: "inline_constructor", sourceFile: "inline_constructor.ts" },
  {
    name: "inline_multiple_instances",
    sourceFile: "inline_multiple_instances.ts",
  },
  { name: "inline_method_chain", sourceFile: "inline_method_chain.ts" },
  { name: "inline_nested", sourceFile: "inline_nested.ts" },
  { name: "inline_with_params", sourceFile: "inline_with_params.ts" },
  { name: "inline_internal_calls", sourceFile: "inline_internal_calls.ts" },
  // --- Operator tests ---
  { name: "operators_arithmetic", sourceFile: "operators_arithmetic.ts" },
  { name: "operators_comparison", sourceFile: "operators_comparison.ts" },
  // --- Control flow tests ---
  { name: "switch_case", sourceFile: "switch_case.ts" },
  { name: "do_while", sourceFile: "do_while.ts" },
  { name: "nested_loops", sourceFile: "nested_loops.ts" },
  // --- Expression and pattern tests ---
  {
    name: "ternary_and_shortcircuit",
    sourceFile: "ternary_and_shortcircuit.ts",
  },
  {
    name: "shortcircuit_side_effects",
    sourceFile: "shortcircuit_side_effects.ts",
  },
  { name: "enum_usage", sourceFile: "enum_usage.ts" },
  { name: "method_patterns", sourceFile: "method_patterns.ts" },
  { name: "inline_state_machine", sourceFile: "inline_state_machine.ts" },
  // --- String operation tests ---
  { name: "string_concat_parts", sourceFile: "string_concat_parts.ts" },
  { name: "template_literal_basic", sourceFile: "template_literal_basic.ts" },
  { name: "string_concat_basic", sourceFile: "string_concat_basic.ts" },
  // --- Mathf tests ---
  { name: "mathf_basic", sourceFile: "mathf_basic.ts" },
  { name: "mathf_advanced", sourceFile: "mathf_advanced.ts" },
  // --- Type conversion tests ---
  { name: "type_conversion", sourceFile: "type_conversion.ts" },
  // --- Variable mutation & accumulation ---
  { name: "compound_assignment", sourceFile: "compound_assignment.ts" },
  {
    name: "compound_assignment_lhs_eval",
    sourceFile: "compound_assignment_lhs_eval.ts",
  },
  { name: "increment_decrement", sourceFile: "increment_decrement.ts" },
  {
    name: "update_expression_semantics",
    sourceFile: "update_expression_semantics.ts",
  },
  { name: "update_statement_effect", sourceFile: "update_statement_effect.ts" },
  // --- Local variables & early returns ---
  { name: "block_scoping", sourceFile: "block_scoping.ts" },
  { name: "early_return", sourceFile: "early_return.ts" },
  // --- Null coalescing & complex boolean ---
  { name: "null_coalescing", sourceFile: "null_coalescing.ts" },
  { name: "complex_boolean", sourceFile: "complex_boolean.ts" },
  // --- String concat & StringBuilder ---
  { name: "string_concat_multi", sourceFile: "string_concat_multi.ts" },
  { name: "string_concat_chain", sourceFile: "string_concat_chain.ts" },
  // --- Method chains ---
  { name: "method_chain_calls", sourceFile: "method_chain_calls.ts" },
  // --- Computation patterns ---
  { name: "fibonacci_iterative", sourceFile: "fibonacci_iterative.ts" },
  // --- DataList & DataDictionary ---
  { name: "data_list", sourceFile: "data_list.ts" },
  { name: "data_dictionary", sourceFile: "data_dictionary.ts" },
  // --- Object literal → DataDictionary conversion ---
  { name: "object_literal_basic", sourceFile: "object_literal_basic.ts" },
  { name: "object_literal_spread", sourceFile: "object_literal_spread.ts" },
  { name: "object_literal_nested", sourceFile: "object_literal_nested.ts" },
  // --- Array literal → DataList conversion ---
  { name: "array_literal_basic", sourceFile: "array_literal_basic.ts" },
  {
    name: "array_literal_iteration",
    sourceFile: "array_literal_iteration.ts",
  },
  // --- DataList / DataDictionary deep operations ---
  { name: "data_list_operations", sourceFile: "data_list_operations.ts" },
  {
    name: "data_dictionary_operations",
    sourceFile: "data_dictionary_operations.ts",
  },
  {
    name: "data_dictionary_getkeys",
    sourceFile: "data_dictionary_getkeys.ts",
  },
  {
    name: "data_dictionary_shallow_clone",
    sourceFile: "data_dictionary_shallow_clone.ts",
  },
  // --- Method inlining edge cases ---
  {
    name: "inline_cross_method_call",
    sourceFile: "inline_cross_method_call.ts",
  },
  {
    name: "inline_multiple_returns",
    sourceFile: "inline_multiple_returns.ts",
  },
  {
    name: "inline_state_read_after_write",
    sourceFile: "inline_state_read_after_write.ts",
  },
  { name: "inline_as_parameter", sourceFile: "inline_as_parameter.ts" },
  { name: "inline_type_alias_arg", sourceFile: "inline_type_alias_arg.ts" },
  // --- Recursive functions ---
  { name: "recursive_factorial", sourceFile: "recursive_factorial.ts" },
  { name: "recursive_with_locals", sourceFile: "recursive_with_locals.ts" },
  { name: "recursive_fibonacci", sourceFile: "recursive_fibonacci.ts" },
  // --- For-of iteration ---
  { name: "for_of_data_list", sourceFile: "for_of_data_list.ts" },
  { name: "for_of_array", sourceFile: "for_of_array.ts" },
  // --- Type coercion & edge cases ---
  {
    name: "type_coercion_int_float",
    sourceFile: "type_coercion_int_float.ts",
  },
  {
    name: "type_coercion_string_number",
    sourceFile: "type_coercion_string_number.ts",
  },
  { name: "optional_chaining", sourceFile: "optional_chaining.ts" },
  { name: "try_catch_error", sourceFile: "try_catch_error.ts" },
  { name: "try_catch_basic", sourceFile: "try_catch_basic.ts" },
  {
    name: "boolean_to_string_format",
    sourceFile: "boolean_to_string_format.ts",
  },
  { name: "negative_numbers", sourceFile: "negative_numbers.ts" },
  { name: "cast_as_expression", sourceFile: "cast_as_expression.ts" },
  // --- Numeric type promotion tests ---
  { name: "numeric_type_promotion", sourceFile: "numeric_type_promotion.ts" },
  { name: "int_arithmetic", sourceFile: "int_arithmetic.ts" },
  // --- Bitwise & shift operator tests ---
  { name: "bitwise_operators", sourceFile: "bitwise_operators.ts" },
  { name: "shift_operators", sourceFile: "shift_operators.ts" },
  // --- Type cast edge cases ---
  { name: "cast_float_to_int", sourceFile: "cast_float_to_int.ts" },
  // --- Restricted type runtime init ---
  { name: "restricted_type_init", sourceFile: "restricted_type_init.ts" },
  // --- Switch statement advanced patterns ---
  { name: "switch_fallthrough", sourceFile: "switch_fallthrough.ts" },
  { name: "switch_string", sourceFile: "switch_string.ts" },
  // --- Deep nested control flow ---
  {
    name: "nested_control_flow_deep",
    sourceFile: "nested_control_flow_deep.ts",
  },
  // --- Mixed type compound assignment ---
  {
    name: "compound_assignment_mixed",
    sourceFile: "compound_assignment_mixed.ts",
  },
  // --- Boolean coercion in logical NOT ---
  { name: "boolean_coercion_not", sourceFile: "boolean_coercion_not.ts" },
  // --- Unary negation on typed integers ---
  { name: "unary_negation_typed", sourceFile: "unary_negation_typed.ts" },
  // --- Large float literal runtime parse ---
  { name: "large_float_literal", sourceFile: "large_float_literal.ts" },
  // --- Complex template literals ---
  {
    name: "template_literal_complex",
    sourceFile: "template_literal_complex.ts",
  },
  // --- Bug fix: increment/decrement operators ---
  { name: "increment_operators", sourceFile: "increment_operators.ts" },
  // --- Bug fix: compound assignment operators ---
  {
    name: "compound_assignment_operators",
    sourceFile: "compound_assignment_operators.ts",
  },
  // --- Bug fix: Convert overload resolution ---
  { name: "convert_overload", sourceFile: "convert_overload.ts" },
  // --- Mixed numeric type operations ---
  {
    name: "mixed_numeric_arithmetic",
    sourceFile: "mixed_numeric_arithmetic.ts",
  },
  {
    name: "mixed_numeric_comparison",
    sourceFile: "mixed_numeric_comparison.ts",
  },
  {
    name: "score_arithmetic_regression",
    sourceFile: "score_arithmetic_regression.ts",
  },
  {
    name: "lru_numeric_compare_regression",
    sourceFile: "lru_numeric_compare_regression.ts",
  },
  {
    name: "tile_sort_compare",
    sourceFile: "tile_sort_compare.ts",
    expectedLogs: ["LT", "GT", "EQ", "LE", "GE"],
  },
  { name: "numeric_cast_chain", sourceFile: "numeric_cast_chain.ts" },
  // --- Multi-part string concat ---
  {
    name: "string_concat_many_parts",
    sourceFile: "string_concat_many_parts.ts",
  },
  {
    name: "string_concat_mixed_types",
    sourceFile: "string_concat_mixed_types.ts",
  },
  // --- String concat binary fallback (ToString coercion in binary +) ---
  {
    name: "string_concat_binary_fallback",
    sourceFile: "string_concat_binary_fallback.ts",
  },
  // --- Array index write/read ---
  {
    name: "array_index_write_read",
    sourceFile: "array_index_write_read.ts",
  },
  {
    name: "system_object_array_extern_core",
    sourceFile: "system_object_array_extern_core.ts",
    expectedLogs: ["concat_ok", "scalar_ok"],
    requiredExterns: datalistArrayCoreExterns,
    disallowedExterns: datalistArrayDisallowedExterns,
  },
  // --- For-of destructuring & break/continue ---
  {
    name: "for_of_dict_destructure",
    sourceFile: "for_of_dict_destructure.ts",
  },
  { name: "for_of_with_break", sourceFile: "for_of_with_break.ts" },
  // --- Template literal multi-part ---
  {
    name: "template_literal_many_parts",
    sourceFile: "template_literal_many_parts.ts",
  },
  // --- DataList set_Item ---
  { name: "data_list_set_item", sourceFile: "data_list_set_item.ts" },
  // --- Switch expression discriminant ---
  {
    name: "switch_expression_discriminant",
    sourceFile: "switch_expression_discriminant.ts",
  },
  { name: "switch_enum_advanced", sourceFile: "switch_enum_advanced.ts" },
  { name: "switch_call_analyzer", sourceFile: "switch_call_analyzer.ts" },
  {
    name: "switch_continue_in_loop",
    sourceFile: "switch_continue_in_loop.ts",
  },
  // --- Short-circuit side effects ---
  {
    name: "short_circuit_side_effects",
    sourceFile: "short_circuit_side_effects.ts",
  },
  // --- Multi inline class interaction ---
  {
    name: "inline_multi_class_interaction",
    sourceFile: "inline_multi_class_interaction.ts",
  },
  {
    name: "inline_return_value_chain",
    sourceFile: "inline_return_value_chain.ts",
  },
  // --- Field initialization ---
  { name: "field_init_order", sourceFile: "field_init_order.ts" },
  // --- Null coalescing chain ---
  { name: "null_coalescing_chain", sourceFile: "null_coalescing_chain.ts" },
  // --- Null coalescing with method returns ---
  {
    name: "null_coalescing_method_returns",
    sourceFile: "null_coalescing_method_returns.ts",
  },
  // --- Try-catch advanced ---
  { name: "try_catch_nested", sourceFile: "try_catch_nested.ts" },
  { name: "try_catch_finally", sourceFile: "try_catch_finally.ts" },
  // --- Loop break/continue ---
  {
    name: "for_loop_break_continue",
    sourceFile: "for_loop_break_continue.ts",
  },
  { name: "loop_variable_scoping", sourceFile: "loop_variable_scoping.ts" },
  // --- Inline field defaults ---
  { name: "inline_field_defaults", sourceFile: "inline_field_defaults.ts" },
  // --- Nested ternary ---
  { name: "nested_ternary", sourceFile: "nested_ternary.ts" },
  // --- Expression in call args ---
  {
    name: "expression_in_call_args",
    sourceFile: "expression_in_call_args.ts",
  },
  // --- For-of dict keys lookup ---
  {
    name: "for_of_dict_keys_lookup",
    sourceFile: "for_of_dict_keys_lookup.ts",
  },
  // --- Bug fix regression tests ---
  { name: "long_field_init", sourceFile: "long_field_init.ts" },
  { name: "nameof_expression", sourceFile: "nameof_expression.ts" },
  { name: "typeof_expression", sourceFile: "typeof_expression.ts" },
  { name: "enum_auto_increment", sourceFile: "enum_auto_increment.ts" },
  {
    name: "element_access_computed",
    sourceFile: "element_access_computed.ts",
  },
  // --- Property access type fallback ---
  {
    name: "property_access_type_fallback",
    sourceFile: "property_access_type_fallback.ts",
  },
  // --- CFG type safety: optimizer with complex control flow ---
  {
    name: "optimized_complex_control_flow",
    sourceFile: "optimized_complex_control_flow.ts",
    optimize: true,
  },
  // --- Static getter returning non-Single type (Vector3) ---
  { name: "static_getter_vector3", sourceFile: "static_getter_vector3.ts" },
  // --- Interface typed variable with inline-only implementors ---
  {
    name: "interface_inline_dispatch",
    sourceFile: "interface_inline_dispatch.ts",
  },
  {
    name: "interface_untracked_dispatch",
    sourceFile: "interface_untracked_dispatch.ts",
  },
  {
    name: "inline_interface_return_dispatch",
    sourceFile: "inline_interface_return_dispatch.ts",
  },
  {
    name: "interface_inline_forof_dispatch",
    sourceFile: "interface_inline_forof_dispatch.ts",
  },
  {
    name: "inline_multi_return_paths",
    sourceFile: "inline_multi_return_paths.ts",
  },
  // --- TS/Udon string compat methods ---
  {
    name: "string_ts_compat_methods",
    sourceFile: "string_ts_compat_methods.ts",
  },
  // --- Expanded coverage: exception/data/interface/control-flow ---
  {
    name: "exception_path_with_rethrow",
    sourceFile: "exception_path_with_rethrow.ts",
  },
  {
    name: "dictionary_iteration_order",
    sourceFile: "dictionary_iteration_order.ts",
  },
  {
    name: "datalist_nested_mutation",
    sourceFile: "datalist_nested_mutation.ts",
  },
  {
    name: "recursion_branching_depth",
    sourceFile: "recursion_branching_depth.ts",
  },
  {
    name: "optional_chaining_method_call",
    sourceFile: "optional_chaining_method_call.ts",
    expectError: true,
  },
  {
    name: "string_concat_deep_mixed",
    sourceFile: "string_concat_deep_mixed.ts",
  },
  {
    name: "for_of_continue_break_mix",
    sourceFile: "for_of_continue_break_mix.ts",
  },
  {
    name: "enum_bitflag_style",
    sourceFile: "enum_bitflag_style.ts",
  },
  {
    name: "interface_dispatch_chained_return",
    sourceFile: "interface_dispatch_chained_return.ts",
  },
  // --- Expanded coverage round 2 ---
  {
    name: "data_dictionary_trygetvalue_flow",
    sourceFile: "data_dictionary_trygetvalue_flow.ts",
  },
  {
    name: "data_list_insert_removeat_flow",
    sourceFile: "data_list_insert_removeat_flow.ts",
  },
  {
    name: "mathf_clamp_round_combo",
    sourceFile: "mathf_clamp_round_combo.ts",
  },
  {
    name: "switch_negative_case",
    sourceFile: "switch_negative_case.ts",
  },
  {
    name: "array_literal_accumulate_reassign",
    sourceFile: "array_literal_accumulate_reassign.ts",
  },
  {
    name: "nullish_ternary_mix",
    sourceFile: "nullish_ternary_mix.ts",
  },
  // --- Expanded coverage round 3: DataContainer + control flow ---
  {
    name: "data_dictionary_getvalues_accumulate",
    sourceFile: "data_dictionary_getvalues_accumulate.ts",
  },
  {
    name: "data_dictionary_overwrite_reinsert",
    sourceFile: "data_dictionary_overwrite_reinsert.ts",
  },
  {
    name: "data_list_insert_middle_shift",
    sourceFile: "data_list_insert_middle_shift.ts",
  },
  {
    name: "data_list_remove_missing_then_add",
    sourceFile: "data_list_remove_missing_then_add.ts",
  },
  {
    name: "control_flow_nested_break_flag",
    sourceFile: "control_flow_nested_break_flag.ts",
  },
  {
    name: "control_flow_switch_in_if_chain",
    sourceFile: "control_flow_switch_in_if_chain.ts",
  },
  {
    name: "control_flow_do_while_continue_break",
    sourceFile: "control_flow_do_while_continue_break.ts",
  },
  {
    name: "control_flow_ternary_continue",
    sourceFile: "control_flow_ternary_continue.ts",
  },
];

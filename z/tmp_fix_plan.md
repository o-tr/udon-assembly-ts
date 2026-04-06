     Plan: Fix VM Test Failures — Array Heap Types, Constructor Params, Type Issues

     Context

     38 VM tests run against Udon VM. 34 fail. After the user's correction: SystemObjectArray operations (Get/Set/ctor/length) work correctly in Udon VM. The base SystemArray
      methods also work. The problem is NOT that array EXTERNs are unsupported — it's that the generated UASM has wrong heap types and wrong extern names, causing runtime
     errors.

     ---
     Root Cause Analysis (verified from actual test results + UASM)

     Failure Category 1: SystemArray.__get_Length__SystemInt32 exception (12 tests)

     Error: UdonVMException: An exception occurred during EXTERN to 'SystemArray.__get_Length__SystemInt32'

     Verified in HandTenpaiTest.uasm:
     SUITS: %SystemArray, null          ← WRONG heap type, should be %SystemObjectArray or %SystemStringArray
     __extern_5: %SystemString, "ObjectArray.__ctor__SystemInt32__ObjectArray"   ← WRONG extern name

     Two bugs interact:

     1. Heap type %SystemArray instead of typed variant — ArrayTypeSymbol.udonType returns UdonType.Array → "Array" → assembler resolves to %SystemArray. Should be
     %SystemObjectArray (or element-typed variant like %SystemInt32Array).

     1. Path: getOperandAddress() (operands.ts:40) stores varOp.type.udonType → "Array" → assembler's resolveUdonTypeName("Array") → toUdonTypeNameWithArray("System.Array") →
      "SystemArray" → %SystemArray
     2. Wrong extern name ObjectArray.__ctor__ instead of SystemObjectArray.__ctor__ — requireExternSignature("ObjectArray", "ctor", ...) produces
     ObjectArray.__ctor__SystemInt32__ObjectArray. Udon VM expects SystemObjectArray.__ctor__SystemInt32__SystemObjectArray.

     2. The ctor likely fails at runtime (extern not found) → array stays null → .length on null throws.

     Failure Category 2: SystemString.__Substring__ exception (7 tile_* tests + hand_operations, meld_validation)

     These are likely null-ref or index-out-of-range errors from String.Substring. Need to investigate — possibly also caused by array initialization failures upstream.

     Failure Category 3: SystemInt32Array.__Set__ exception (tile_counts)

     Likely same root cause — wrong heap type causes type mismatch.

     Failure Category 4: score_arithmetic — constructor arg propagation (1 test)

     Expected: '25000', Got: '0'. Constructor parameter properties (constructor(public value: UdonInt)) don't synthesize this.value = value.

     Failure Category 5: lru_cache — type promotion issue (1 test)

     Separate issue — UdonInt compared as SystemSingle.

     ---
     Fix 1: Array Heap Type and Extern Names

     1a. Fix heap type for ArrayTypeSymbol operands

     File: src/transpiler/codegen/tac_to_udon/operands.ts

     In getOperandAddress(), when storing the variable/temp type, detect ArrayTypeSymbol and store a typed array name instead of raw UdonType.Array.

     Line 40 (Variable case): Extract a helper to compute typed array name:

     import { ArrayTypeSymbol } from "../../frontend/type_symbols.js";

     function resolveHeapType(operand: TACOperand): string {
       const typeSymbol = (operand as unknown as { type: TypeSymbol }).type;
       if (typeSymbol instanceof ArrayTypeSymbol) {
         // getOperandTypeName returns "SystemObjectArray", "SystemInt32Array", etc.
         return this.getOperandTypeName(operand);
       }
       return typeSymbol.udonType;
     }

     Apply at line 40: this.variableTypes.set(normalizedName, resolveHeapType(varOp));
     Apply at line 50: this.tempTypes.set(tempOp.id, resolveHeapType(tempOp));

     Do NOT change line 62 (Constant case) — constants never have array type, and the naming pattern __const_${addr}_System${type} would produce a double-"System" prefix if
     the type were "SystemObjectArray". Since array constants are never created, this is a non-issue.

     The resolveUdonTypeName in the assembler already handles these names correctly — "SystemObjectArray" starts with "System", skips the System. prefix branch, and passes
     through toUdonTypeNameWithArray unchanged.

     1b. Fix ObjectArray extern name in requireExternSignature calls

     File: src/transpiler/ir/ast_to_tac/helpers/assignment.ts

     Change "ObjectArray" to "object[]" in 3 requireExternSignature call sites (each has 2 string occurrences — type name and return type):

     - Lines 395-400: coerceToNativeArray ctor — "ObjectArray" → "object[]" (2 occurrences)
     - Lines 463-468: emitArrayConcat ctor — "ObjectArray" → "object[]" (2 occurrences)

     File: src/transpiler/ir/ast_to_tac/visitors/call.ts

     - Lines 1532-1537: concat scalar wrapper ctor — "ObjectArray" → "object[]" (2 occurrences)

     Note: Lines 1705 and 1834 in call.ts use "SystemObjectArray" directly (the Udon name) in string interpolation and are already correct — NOT affected.

     These will resolve through mapTypeScriptToCSharp("object[]") → "System.Object[]" → toUdonTypeNameWithArray → "SystemObjectArray", producing the correct extern
     SystemObjectArray.__ctor__SystemInt32__SystemObjectArray.

     1c. Verify SystemArray.Length and SystemArray.Copy extern names

     These use requireExternSignature("SystemArray", "Length", ...) and requireExternSignature("SystemArray", "Copy", ...).

     - SystemArray.__get_Length__SystemInt32 — this is valid (confirmed in UdonSharp and existing passing UASM)
     - SystemArray.__Copy__SystemObject_SystemInt32_SystemObject_SystemInt32_SystemInt32__SystemVoid — this is valid (confirmed in UdonSharp's List.cs implementation)

     No changes needed for these two.

     1d. Verify typed array ctor in push/splice uses correct names

     In call.ts, the push implementation already computes arrayUdonType from element type and uses it for the ctor. Need to verify it produces correct names for both known
     types (e.g., SystemInt32Array) and unknown types (→ SystemObjectArray).

     File: src/transpiler/ir/ast_to_tac/visitors/call.ts around line 1700

     const arrayUdonType = isKnownExternElementType(elemName)
       ? toUdonTypeNameWithArray(`${mapTypeScriptToCSharp(elemName)}[]`)
       : "SystemObjectArray";

     This correctly produces SystemObjectArray for unknown types. No change needed here — but the fallback ctor usage (when isKnownExternElementType is false) at lines
     1533/1537 uses "ObjectArray" which IS wrong (covered by fix 1b).

     ---
     Fix 2: Constructor Parameter Property Propagation

     File: src/transpiler/frontend/parser/visitors/declaration.ts

     Lines 129-160 detect constructor parameter properties and add them to the properties array. But no synthesized this.param = param assignment is added to the constructor
     body.

     Key constraint: The AST type ClassDeclarationNode.constructor.parameters doesn't carry an isPropertyParameter flag. The TypeScript AST's param.modifiers (which contains
     public/private/protected/readonly) is only available during parsing. Therefore, the fix must be done in the parser (declaration.ts) where param.modifiers is still
     accessible.

     Fix: After building the constructor body (line 122), within the same loop at lines 129-160 that already detects hasPropertyModifier, also synthesize this.param = param
     assignment AST nodes and insert them into the body.

     Insertion point matters: In TypeScript, parameter property assignments happen AFTER super() but BEFORE the rest of the constructor body. So:

     1. After building the body (line 122), scan body.statements for the first super() call
     2. Collect synthesized assignments for ALL parameter properties detected in lines 129-160
     3. Insert them after super() if present, at start if not

     // After line 122 (body = this.visitBlock(member.body)), before line 123:
     const synthAssignments: ASTNode[] = [];
     for (const param of member.parameters) {
       const hasPropertyModifier = param.modifiers?.some(mod =>
         mod.kind === ts.SyntaxKind.PublicKeyword || ... ) ?? false;
       if (!hasPropertyModifier && !serializeFieldParams.has(param.name.getText())) continue;
       const paramName = param.name.getText();
       synthAssignments.push({
         kind: ASTNodeKind.ExpressionStatement,
         expression: {
           kind: ASTNodeKind.AssignmentExpression,
           target: {
             kind: ASTNodeKind.PropertyAccessExpression,
             object: { kind: ASTNodeKind.ThisExpression },
             property: paramName,
           },
           value: { kind: ASTNodeKind.Identifier, name: paramName },
         },
       });
     }
     if (synthAssignments.length > 0 && body) {
       // Find super() call - multi-level check: ExpressionStatement > CallExpression > SuperExpression
       const superIdx = body.statements.findIndex(s =>
         s.kind === ASTNodeKind.ExpressionStatement &&
         (s as ExpressionStatementNode).expression?.kind === ASTNodeKind.CallExpression &&
         ((s as ExpressionStatementNode).expression as CallExpressionNode)?.callee?.kind === ASTNodeKind.SuperExpression
       );
       const insertIdx = superIdx >= 0 ? superIdx + 1 : 0;
       body.statements.splice(insertIdx, 0, ...synthAssignments);
     }

     Why AST-level is correct: Since the synthesis happens in the parser, ALL downstream paths that visit the constructor body (inline constructors, entry-point constructors,
      super() inlining) automatically get the synthesized assignments. No changes needed in inline.ts.

     Edge cases handled:
     - Multiple parameter properties — synthesized for each, all inserted at same position
     - Parameter with default value — the default is handled by the property declaration, not the assignment
     - super() call — synthesized assignments go AFTER super (multi-level AST detection)
     - No super() — synthesized assignments go at start of body

     ---
     Fix 3: UdonInt → SystemSingle Misconversion (lru_cache)

     Investigation needed. The error is SystemSingle.__op_Inequality__SystemSingle_SystemSingle__SystemBoolean when comparing Int32 values.

     Likely causes:
     - Default numeric type is Single; the inline class field type or Map.size gets a Single default
     - Need to trace how this.cache.size > this.maxSize is compiled for LRUCache inline class

     Will investigate during implementation and fix based on findings.

     ---
     Fix 4: Negative Slice Index Not Adjusted (tile_* tests)

     7 tests fail with SystemString.__Substring__ exception: tile_parse, tile_predicates, tile_sort_compare, tile_dora, hand_operations, meld_validation, dora_calculator.

     Root cause: string.slice(0, -1) and string.slice(-1) pass negative indices directly to String.Substring, which doesn't support negative indices. JavaScript's .slice()
     treats negative indices as length + index.

     File: src/transpiler/ir/ast_to_tac/visitors/call.ts lines 1431-1454

     The current isNegConst check only matches ConstantOperand with negative .value:
     const isNegConst = (op: TACOperand): boolean =>
       op.kind === TACOperandKind.Constant &&
       Number((op as ConstantOperand).value) < 0;

     But the parser produces UnaryMinus(Constant(1)) for -1, yielding a TemporaryOperand. The isNegConst check fails, and the negative value is passed directly to Substring.

     Fix: Replace the compile-time isNegConst check with a runtime negative-index check in resolveIndex:

     const resolveIndex = (arg: TACOperand): TACOperand => {
       const intArg = toInt32(arg);
       // Runtime check: if (intArg < 0) intArg = length + intArg
       const zero = createConstant(0, PrimitiveTypes.int32);
       const isNeg = this.newTemp(PrimitiveTypes.boolean);
       this.instructions.push(new BinaryOpInstruction(isNeg, intArg, "<", zero));
       const skipLabel = this.newLabel("slice_pos");
       // ConditionalJumpInstruction jumps when FALSE → skip adjustment when NOT negative
       this.instructions.push(new ConditionalJumpInstruction(isNeg, skipLabel));
       const adjusted = adjustNegIndex(intArg);
       this.instructions.push(new CopyInstruction(intArg, adjusted));
       this.instructions.push(new LabelInstruction(skipLabel));
       return intArg;
     };

     This handles ALL negative indices (constants, temporaries, variables) correctly at runtime, matching JavaScript's .slice() semantics.

     ---
     Verification

     1. pnpm typecheck — type checking
     2. pnpm test — all 772+ unit tests must pass
     3. UNITY_EDITOR_PATH=/Applications/Unity/Hub/Editor/2022.3.22f1/Unity.app/Contents/MacOS/Unity pnpm test:vm — VM tests
     4. Check generated UASM: no %SystemArray heap types (should be %SystemObjectArray etc.), no ObjectArray.__ctor__ (should be SystemObjectArray.__ctor__)
     5. Check generated UASM: negative slice indices should produce runtime branch, not direct pass-through

     Execution Order

     1. Fix 1a (heap types) + Fix 1b (extern names) — fixes 25+ array-related failures
     2. Fix 2 (constructor params) — fixes score_arithmetic
     3. Fix 4 (negative slice indices) — fixes 7 tile/string failures
     4. Run unit tests, fix regressions
     5. Regenerate UASM and run VM tests
     6. Fix 3 (type promotion) — investigate and fix lru_cache if still failing
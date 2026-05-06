---
created: 2026-05-07T03:00:00+09:00
updated: 2026-05-07T03:00:00+09:00
status: open
severity: medium
component: transpiler / TAC optimizer
related_branch: feat/readonly-array-folding
---

# Constant folding for readonly DataList/DataDictionary collections

## Summary

`readonlyArrayFolding` only targets `NativeArrayTypeSymbol` (fixed-length
primitive arrays). Constant lookup tables backed by `DataList` or
`DataDictionary` are not folded.

## Background

DataList/DataDictionary emit a fundamentally different TAC pattern from native
arrays:

```
// DataList pattern
t0 = call DataList.ctor()
call t0.Add(dataToken_10)
call t0.Add(dataToken_20)
call t0.Add(dataToken_30)
scores = t0
...
t1 = call scores.get_Item(0)   // MethodCallInstruction, not ArrayAccess
```

- Element writes use `MethodCallInstruction` (`Add`, `SetValue`), not
  `ArrayAssignmentInstruction`.
- Element reads use `MethodCallInstruction` (`get_Item`), not
  `ArrayAccessInstruction`.
- DataList indices are implicit (insertion order); DataDictionary uses string
  keys.

## Why it matters

Non-primitive-element arrays (object arrays, mixed-type collections) cannot
become `NativeArrayTypeSymbol` and are emitted as DataList instead. Constant
lookup tables of this kind — common in VRChat scripts — remain unoptimized.

## Proposed approach

Implement as a separate optimizer pass rather than extending
`readonlyArrayFolding`, since the instruction patterns differ fundamentally.

- Detect `CallInstruction` for `DataList.ctor()` / `DataDictionary.ctor()`.
- Track `MethodCallInstruction` calls to `Add` / `SetValue` to build a
  contents map.
- Replace `get_Item` / `TryGetValue` with constant keys by the stored constant
  value.
- Account for DataToken wrapping/unwrapping around stored values.

## Relevant files

- `src/transpiler/ir/ast_to_tac/helpers/data_dictionary.ts` (lines 24-191) — DataDictionary TAC generation
- `src/transpiler/ir/ast_to_tac/visitors/expression.ts` (visitArrayLiteralExpression) — DataList TAC generation
- `src/transpiler/ir/optimizer/passes/readonly_array_folding.ts` — reference implementation

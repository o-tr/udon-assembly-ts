---
created: 2026-05-07T03:00:00+09:00
updated: 2026-05-07T14:35:00+09:00
status: closed
severity: medium
component: transpiler / TAC optimizer
related_branch: fix/datalist-datadictionary-constant-folding
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

## Resolution

Implemented in `fix/datalist-datadictionary-constant-folding` (commit `90a5a87`).

### Implementation summary

New pass `readonlyDataCollectionFolding` in
`src/transpiler/ir/optimizer/passes/readonly_data_collection_folding.ts`,
registered immediately after `readonlyArrayFolding` in `tac_optimizer.ts`.

**Pass 1** tracks `DataList`/`DataDictionary` ctor calls as candidates, follows
`Add`/`SetValue` calls to build a contents map (indexed by insertion order or
string key), and validates candidates against mutations and escapes.

**Pass 2** rewrites `get_Item`/`GetValue` with constant keys to
`CallInstruction(DataToken.ctor, storedValue)`. For non-Int types (String,
Boolean, Float, Double), an immediately following `PropertyGet` unwrap is also
folded to a direct `AssignmentInstruction`.

**Pass 3** dead-code-eliminates init instructions for candidates whose remaining
uses all became zero after folding.

### Key design decisions

- **Alias-before-adds pattern**: the real transpiler emits `alias = ctor` before
  any `Add` calls (unlike native arrays). Alias assignment only transitions to
  `post-init` if init operations have already started (`nextIndex > 0 ||
  contents.size > 0`); otherwise the candidate stays in `init` so subsequent
  `Add`/`SetValue` via the alias are tracked correctly.
- **`get_Item` for DataDictionary**: bracket access `dict["key"]` compiles to
  `get_Item` with a string constant arg (not `GetValue` with a DataToken key).
  Both methods are handled by the same folding branch since `resolveStringKey`
  handles both constant strings and DataToken-wrapped string temporaries.
- **Int type exclusion from PropertyGet folding**: `unwrapDataToken` emits a
  7-instruction null-check diamond for Int types; immediate PropertyGet folding
  would be unsound. Only non-null-check types (String, Boolean, Float, Double,
  DataList, DataDictionary) are folded through.

### Test coverage

28 unit tests (`tests/unit/transpiler/optimizer_readonly_data_collection.test.ts`)
and 1 e2e test (`tests/unit/transpiler/optimizer_readonly_data_collection_e2e.test.ts`)
confirming the pass fires on real transpiler output.

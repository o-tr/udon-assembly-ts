---
created: 2026-05-07T03:00:01+09:00
updated: 2026-05-07T13:40:00+09:00
status: closed
severity: low
component: transpiler / TAC optimizer
related_branch: fix/type-default-folding-for-uninitialized-slots
fixed_commit: 221956c
---

# Fold constant-index access to uninitialized native array slots as type defaults

## Summary

`readonlyArrayFolding` only folds elements that were explicitly written via
`ArrayAssignment`. Constant-index reads from allocated-but-unwritten slots
(zero-initialized by the Udon VM) are left unchanged.

## Example

```typescript
const arr: number[] = new Array<number>(3);
arr[0] = 10;
// arr[1], arr[2] never written — zero-initialized
const x = arr[1];  // currently not folded; expected: x = 0
```

## Why it is safe

Udon native arrays are zero-initialized at construction time. The type-default
values are well-defined:

- `Int32`, `UInt32`, etc. → `0`
- `Single`, `Double` → `0.0`
- `Boolean` → `false`
- `String` → `""` (empty string)

`createSoaSentinelValue()` in
`src/transpiler/ir/ast_to_tac/helpers/inline.ts` (lines 1101-1151) already
contains a type-default mapping that can be reused.

## Proposed fix

In `readonlyArrayFolding` Pass 2, when `contents.get(idx)` returns `undefined`
(index was never written), fold to the element type's default constant value
instead of skipping the fold.

Guard conditions:
- Index is within bounds: `0 <= idx < arrayLength`.
- `arrayLength` is the constant integer from the ctor's first argument (needs
  to be stored on the candidate — removed in the current implementation but
  easy to restore).

## Relevant files

- `src/transpiler/ir/optimizer/passes/readonly_array_folding.ts` — Pass 2 fold logic
- `src/transpiler/ir/ast_to_tac/helpers/inline.ts` (lines 1101-1151) — existing type-default values

## Resolution

Implemented in commit `221956c` on branch `fix/type-default-folding-for-uninitialized-slots`.

**Approach:**
- Added `arrayLength` and `elementType` fields to `ArrayCandidate` (stored from ctor call in Pass 1)
- Added `getTypeDefault()` helper mapping element type to its zero-init constant:
  - Numeric types → `0` (Int32, UInt32, Single, Double, etc.)
  - Boolean → `false`
  - String → `null` (C# `default(string)` is null, not `""`)
  - Other reference types → not folded (conservative)
- Pass 2 now uses `contents.has(idx)` to distinguish never-written slots (fold to default) from non-constant writes (`null` entry, skip fold), with bounds guard `0 <= idx < arrayLength`

**Note:** The issue proposed `String → ""` but the correct C# zero-init default is `null`
(`isNullableUdonType()` in `type_symbols.ts` lists `UdonType.String` as a nullable type).
Folding to `""` would silently break code that checks `arr[i] == null` on unwritten slots.

7 new tests added to `tests/unit/transpiler/optimizer_readonly_array.test.ts`.

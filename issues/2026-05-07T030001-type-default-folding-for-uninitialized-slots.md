---
created: 2026-05-07T03:00:01+09:00
updated: 2026-05-07T03:00:01+09:00
status: open
severity: low
component: transpiler / TAC optimizer
related_branch: feat/readonly-array-folding
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

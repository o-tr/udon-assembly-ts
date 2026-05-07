---
created: 2026-05-08T02:00:00+09:00
updated: 2026-05-08T12:00:00+09:00
status: closed
severity: low
component: transpiler / IR array literal narrowing
related_tests: tests/unit/transpiler/optimizer_regression.test.ts
---

# `number[]` with integer literals uses SystemDoubleArray; should narrow to SystemInt32Array

## Summary

When a `number[]` variable is initialised with an array literal whose elements
are all compile-time integer constants, the transpiler emits a `SystemDoubleArray`
(because TypeScript `number` maps to Udon `Double`).  For UdonSharp parity the
array should use `SystemInt32Array`, avoiding the Double ↔ Int32 round-trip
conversions on every read/write.

Two `it.fails` tests in `optimizer_regression.test.ts` track this gap:

- `array_index_mutation should stay on Int32Array path` (line 328)
- `array_reassign_then_read should avoid float-conversion array pipeline` (line 359)

## Reproducers

```ts
// Case 1 — explicit annotation
const values: number[] = [1, 2, 3, 4];
values[1] = values[0] + values[2];   // Double[] today → Int32[] desired
```

```ts
// Case 2 — inferred type
const values = [2, 4, 6];
values[0] = values[1] + 1;           // Double[] today → Int32[] desired
```

## Current output (optimize: true)

- `SystemDoubleArray.__ctor__SystemInt32__SystemDoubleArray` (allocation)
- `SystemConvert.__ToInt32__SystemDouble__SystemInt32` round-trip on every
  element read used in integer arithmetic

_(Before the `number → Double` remap the symptom was `SystemSingleArray` —
the test names still say "SingleArray" but the underlying issue is the same.)_

## Expected output

- `SystemInt32Array.__ctor__SystemInt32__SystemInt32Array`
- No `ToDouble / ToInt32` conversions in the hot path
- Instruction count ≤ 63 (case 1) / ≤ 59 (case 2)

## Fix sketch

**Option A — array-literal narrowing in the IR visitor**
In `visitArrayLiteralExpression` (`src/transpiler/ir/ast_to_tac/visitors/expression.ts`),
when `elementType.udonType === UdonType.Double` (i.e. declared as `number[]`)
and every element in the literal is a `NumericLiteralNode` whose value has no
fractional part, override the element type to `PrimitiveTypes.int32`.  This
keeps the rest of the native-array path unchanged and narrows the allocation
type at the call site where element type information is available.

Caveats:
- Only safe when **every element** of the initialiser is an integer constant.
- Subsequent mutations (`values[i] = expr`) would also need to stay Int32 — if
  the optimizer can't guarantee this, a runtime store of a Double into an Int32
  slot will trap.  For the two reproducer cases all arithmetic is integer-typed
  after element types are demoted, so this is safe.

**Option B — optimizer pass**
A post-IR optimizer pass could detect `SystemDoubleArray` variables whose
entire write set consists of Int32-range values and rewrite the allocation +
stores.  More robust but more complex.

## Severity

Optimisation only.  No correctness regression — wrong type simply generates
extra conversion externs, which are functionally correct but slower and larger.

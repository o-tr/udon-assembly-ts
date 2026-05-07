---
created: 2026-05-07T02:40:03+09:00
updated: 2026-05-07T16:25:00+09:00
status: closed
severity: low
component: transpiler / TAC binary expression
related_branch: feat/number-double-mapping
related_plan: ~/.claude/plans/drifting-conjuring-walrus.md (§ Phase B-3, deferred)
---

# Propagate `currentExpectedType` through binary expressions for richer Int32 demote

## Summary

`feat/number-double-mapping` introduces a literal-only Int32 demote
(visitLiteral with range-checked `valueFitsInIntegerType`) and an array-index
expected-type injection. `arr[i]` with a literal index demotes correctly, but
`arr[i + 1]` with `i: number` (Double) keeps the right-hand `1` as Double
because no Int32 expected type context was propagated to the binary expression
inside the array index.

## Reproducer

```ts
const arr: number[] = [1, 2, 3];
let i = 0;            // Double after Phase A
arr[i + 1] = 99;      // now demotes `1` to Int32 via expected type propagation
```

Expected: when the binary op result is consumed in an Int32-expected
context, demote integer-literal operands to Int32 and avoid the ToInt32.

Current (fixed): array index expressions now set `currentExpectedType = Int32`
before visiting their sub-expression, enabling `widenNumericOperands` to demote
literal operands like `1` in `arr[i + 1]`.

## Implementation

Added save/restore pattern around index expression visits in three locations:

- `src/transpiler/ir/ast_to_tac/visitors/expression.ts` — `visitArrayAccessExpression` (read path)
- `src/transpiler/ir/ast_to_tac/visitors/expression.ts` — `visitDeleteExpression` (delete on array access)
- `src/transpiler/ir/ast_to_tac/helpers/assignment.ts` — `assignToTarget` (write path for compound assignments)

Pattern applied:
```ts
const prevExpectedType = this.currentExpectedType;
this.currentExpectedType = PrimitiveTypes.int32;
let index: TACOperand | undefined;
try {
  index = this.visitExpression(arrayAccess.index);
} finally {
  this.currentExpectedType = prevExpectedType;
}
```

## Commits

- `0a715c3` fix(transpiler): propagate Int32 expected type for array index expressions

## Severity

Optimisation only. No correctness regression. All 893 tests pass.

## References

- Plan: `~/.claude/plans/drifting-conjuring-walrus.md` (§ Phase B-3, deferred)
- Branch: `feat/number-double-mapping`

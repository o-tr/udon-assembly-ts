---
created: 2026-05-07T02:40:03+09:00
updated: 2026-05-07T02:40:03+09:00
status: open
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
because `visitBinaryExpression` does not propagate the array-index expected
type into its operands. The runtime still works (a SystemConvert.ToInt32 is
emitted), but the demote optimisation is missed.

## Reproducer

```ts
const arr: number[] = [1, 2, 3];
let i = 0;            // Double after Phase A
arr[i + 1] = 99;      // currently emits ToInt32(Double); demote could keep Int32
```

Expected: when the binary op result is consumed in an Int32-expected
context, demote integer-literal operands to Int32 and avoid the ToInt32.

Current: only the outermost literal in an Int32-expected position is
demoted; `i + 1` runs as Double + Double = Double, then Convert.ToInt32.

## Why deferred from Phase B

The constant-folding pass (`src/transpiler/ir/optimizer/passes/constant_folding.ts`)
already folds `27 + 5` to a single constant when the optimizer is on. It does
NOT propagate expected types — folding is target-driven via
`isIntegerUdonType(target)` at the assignment site.

For correctness this is fine — the implicit ToInt32 conversion handles all
cases. This is purely a code-size / extra-EXTERN reduction.

## Where to investigate

- `src/transpiler/ir/ast_to_tac/visitors/expression.ts` — `visitBinaryExpression`
  (around `widenNumericOperands`). Current logic widens left/right to a common
  numeric type; a richer pass could push `currentExpectedType` into both
  operands when both are integer-fitting literals.
- Coordinate with `valueFitsInIntegerType` (helpers/expression.ts in branch)
  for the range-safety check.

## Severity

Optimisation only. No correctness regression.

## References

- Plan: `~/.claude/plans/drifting-conjuring-walrus.md` (§ Phase B-3, deferred)
- Branch: `feat/number-double-mapping`

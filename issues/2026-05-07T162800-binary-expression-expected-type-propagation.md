---
created: 2026-05-07T16:28:00+09:00
updated: 2026-05-07T16:28:00+09:00
status: open
severity: low
component: transpiler / TAC binary expression
related_branch: binary-op-expected-type-propagation
---

# Propagate expected type through standalone binary expressions

## Summary

The fix for #2026-05-07T024003-binary-op-expected-type-propagation addressed array index contexts specifically (read, delete, write paths). However, the broader issue of propagating `currentExpectedType` through standalone binary expressions remains unresolved.

When a binary expression is not consumed in an expected type context (e.g., `let x = a + 1;` where `x: number`), neither operand benefits from Int32 demote even if they contain integer-fitting literals.

## Current Limitation

The save/restore pattern we added only affects array index sub-expressions:
- `visitArrayAccessExpression`: ✅ fixed (index gets Int32 context)
- `visitDeleteExpression`: ✅ fixed (index gets Int32 context)  
- `assignToTarget` for array indices: ✅ fixed (index gets Int32 context)

But standalone binary expressions have no such propagation:
```ts
let x = 1 + 2;           // Double + Double, could be Int32 + Int32
arr[i] = 1 + 2;          // The `1 + 2` is evaluated without expected type context before assignment widens it
```

## Where to investigate

- `src/transpiler/ir/ast_to_tac/visitors/expression.ts` — `visitBinaryExpression` (~line 992)
  Currently visits left/right operands without any expected type injection.
  A richer pass could push `currentExpectedType` into both operands when the result
  is consumed in an Int32-expected context (e.g., from assignment widening).

## Proposed Approach

1. Add save/restore guard around left operand visit for binary expressions where
   the operator produces a numeric type that could benefit from Int32 narrowing.
2. Coordinate with `widenNumericOperands` (line 450-493) which already checks
   `converter.currentExpectedType` — the fix would make this check meaningful
   for binary expressions themselves, not just their sub-expressions.

## Severity

Optimisation only. No correctness regression. The existing widening logic handles all cases at runtime.

## References

- Related issue: #2026-05-07T024003-binary-op-expected-type-propagation (array index fix)
- Branch: `binary-op-expected-type-propagation` (commit 0a715c3)

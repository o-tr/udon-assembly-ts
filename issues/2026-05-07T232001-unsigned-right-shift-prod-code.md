---
created: 2026-05-07T23:20:01+09:00
updated: 2026-05-07T23:20:01+09:00
status: open
severity: medium
component: transpiler / expression lowering
related_branch: master
related_test: mahjong-t2 VM `hand_operations` (and any other suite using `>>>`)
---

# Unsigned right shift (`>>>`) is unsupported but appears in production code paths

## Summary

The transpiler emits `UnsupportedOperator` for `>>>` and tells users to either
switch to `>>` or pre-mask with `0xFFFFFFFF`. In practice `>>>` shows up in
real mahjong-t2 source — not just hand-written tests — including a binary-search
midpoint calculation that's reached on every `Hand.addTile` / `Hand.clone`
operation. When the warning fires, the lowered expression appears to produce
broken control flow, and the downstream VM run crashes inside
`SystemInt32.op_LessThan` because the comparison is run on garbage.

## Symptom

mahjong-t2 transpile log:

```text
[UnsupportedOperator] tests/vm/cases/hand/hand_operations.ts:22:5 (HandOperationsTest.Start)
  Unsigned right shift (>>>) is not supported in Udon. Use >> instead, or mask
  with 0xFFFFFFFF before shifting.
[UnsupportedOperator] tests/vm/cases/hand/hand_operations.ts:57:5 (HandOperationsTest.Start)
  ... (same)
```

(The reported line numbers point to the `addTile` call sites; the `>>>` itself
is inside `Hand.addTile` → binary-search helper, which the diagnostic surfaces
at the call site after inlining.)

VM failure:

```text
Inner: UdonVMException: An exception occurred during EXTERN to
  'SystemInt32.__op_LessThan__SystemInt32_SystemInt32__SystemBoolean'.
Expected logs: ["1m","3","4","2p","3","2","3","6","2","3"]
Captured logs: ["1m","3"]
```

The VM gets through the first two `Debug.Log` calls (literal access + length),
then crashes at the first `addTile` invocation.

## Production usages of `>>>` in mahjong-t2

```text
src/core/domain/value-objects/Hand.ts:49        const mid = (lo + hi) >>> 1;
src/core/infrastructure/utils/SeededRandomGenerator.ts:16  this.state = ... seed >>> 0
src/core/infrastructure/utils/SeededRandomGenerator.ts:28  return ... (this.state >>> 0) / 4294967296
src/vrc/utils/StatePackingCodec.ts:170          UdonTypeConverters.toUdonInt(state.seed >>> 0)
```

`>>> 1` for binary-search midpoint and `>>> 0` for unsigned-int cast are both
common JS idioms; rejecting them outright forces every call site to be
rewritten manually.

## Where to investigate

- `src/transpiler/ir/ast_to_tac/visitors/expression.ts:~1120` — the
  `UnsupportedOperator` emit for `>>>`. Replace with a synthesised lowering:
  - `a >>> b` → `(a & 0xFFFFFFFF) >> b` for the integer case (after bigint
    migration this becomes the canonical lowering).
  - `a >>> 0` (and other zero-shift-amount cases) is just an unsigned coercion
    — could be folded to an identity cast on UdonInt / UdonUInt.

## Risks / caveats

- Need to be careful about operand width. With the bigint-int migration
  (#024002, #183000), the transpiler now distinguishes `UdonInt` /
  `UdonUInt` / `UdonLong` / `UdonULong`. Pre-masking with `0xFFFFFFFF` is
  correct only for 32-bit operands.
- Sign behaviour of Udon's `>>` opcode on negative integers should be
  verified before enabling automatic lowering. If `>>` is signed, the
  pre-mask is required; if Udon already provides an unsigned shift opcode
  for some types, prefer that.

## Severity

Medium. Blocks any production code that uses `>>>`; rewriting every site
manually is feasible but tedious and error-prone (the masking variant is
verbose enough that contributors will get it wrong).

## References

- `src/transpiler/ir/ast_to_tac/visitors/expression.ts:1120`
- Related migration issues: #024002 (bigint params), #183000 (branded
  bigint subtypes)
- mahjong-t2 VM `hand_operations` failure log (post-merge, 2026-05-07)

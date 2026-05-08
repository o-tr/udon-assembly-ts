---
created: 2026-05-08T12:30:00+09:00
updated: 2026-05-08T13:06:00+09:00
status: fixed
severity: critical
component: transpiler / numeric codegen
related_test: mahjong-t2 VM suite
fix_commit: math-truncate-double-vm-crash branch
---

# Mahjong VM suite crashes broadly on `SystemMath.__Truncate__SystemDouble__SystemDouble`

## Summary

The mahjong-t2 VM suite now fails 32 of the 33 failing cases with the same
runtime exception:

```text
Inner: UdonVMException: An exception occurred during EXTERN to
  'SystemMath.__Truncate__SystemDouble__SystemDouble'.
```

Only `lru_cache` fails on a different extern. The shared `Truncate(Double)`
crash prevents nearly every mahjong domain fixture from producing logs, so this
is currently the primary blocker for using the mahjong-t2 VM suite as a
regression signal.

## Latest observed result

mahjong-t2 VM run at 2026-05-08 12:14 JST:

```text
Test Files  1 failed (1)
Tests       33 failed | 5 passed (38)
Duration    494.09s
```

Passing tests:

- `simple_test`
- `tile_test`
- `round_transition`
- `game_end_check`
- `score_arithmetic`

Representative failing tests and PCs:

- `tile_parse`, `tile_predicates`, `tile_dora`, `dora_calculator`:
  `PC: 0x000010C0`
- `tile_sort_compare`: `PC: 0x0000106C`
- `hand_operations`, `meld_validation`: `PC: 0x000010D0`
- `tile_counts`: `PC: 0x0000137C` after logs `["34","0"]`
- `hand_tenpai`, `tenpai_edge`: `PC: 0x000443F8`
- yaku / hand-win fixtures: `PC: 0x00051F2C`
- scoring fixtures: `PC: 0x000525B4`

## Why this looks like one root issue

The same extern traps across unrelated features: tile parsing, tile predicates,
hand operations, meld validation, yaku detection, tenpai analysis, and scoring.
The PC clusters suggest a small number of shared generated numeric helper paths
rather than independent mahjong logic bugs.

Given the current branch history, likely suspects are:

- `number` now mapping to Udon `Double`, causing integer-only code paths to emit
  `Math.Truncate(Double)` before array indexes, modulo/division, or enum-like
  integer operations.
- A Double slot is uninitialised, null-backed, NaN, or otherwise invalid for the
  Udon VM's `SystemMath.Truncate` extern.
- Integer narrowing is happening too late: generated code calls
  `Truncate(Double)` where the source value should have remained `Int32`.

## UASM deep dive

The generated UASM in `tests/vm/unity-project/TestInput` narrows the likely
root cause from "bad Double value" to "heap slot type mismatch caused by raw
COPY into a differently typed local".

For `TileParseTest.uasm`, the crash PC from the VM log is `0x000010C0`
(`4288` decimal). PC-to-line mapping shows:

```text
4272 endif15:
4272     PUSH, code
4280     PUSH, __tcast_206
4288     EXTERN, __extern_6
4296     PUSH, __tcast_206
4304     PUSH, __t62
4312     EXTERN, __extern_7
```

The data section declares:

```text
code: %SystemDouble, null
__t62: %SystemInt32, null
__tcast_206: %SystemDouble, null
__extern_6: "SystemMath.__Truncate__SystemDouble__SystemDouble"
__extern_7: "SystemConvert.__ToInt32__SystemDouble__SystemInt32"
```

But immediately before this cast sequence, the same `code` slot is assigned
from Int32 arithmetic with a raw `COPY`:

```text
PUSH, suitIdx
PUSH, __const_31_SystemInt32
PUSH, __t59
EXTERN, SystemInt32.__op_Multiplication...
PUSH, rankNum
PUSH, __const_6_SystemInt32
PUSH, __t60
EXTERN, SystemInt32.__op_Subtraction...
PUSH, __t59
PUSH, __t60
PUSH, __t61
EXTERN, SystemInt32.__op_Addition...
PUSH, __t61
PUSH, code
COPY
```

This corresponds to `mahjong-t2/src/core/domain/value-objects/Tile.ts`:

```ts
let code: number;
code = suitIdx * 9 + (rankNum - 1);
return Tile.fromCode(UdonTypeConverters.toUdonInt(code));
```

Because TypeScript `number` maps to Udon `Double`, `code` is declared as
`SystemDouble`. The expression assigned to it is inferred/emitted as `Int32`.
`emitCopyWithTracking` currently emits a plain `CopyInstruction` and does not
insert numeric coercion for mismatched assignment types. The later
`toUdonInt(code)` cast sees the declared type (`Double`) and emits
`Math.Truncate(Double)`, but the heap slot appears to contain an Int32 value.
Udon VM extern dispatch then reads the slot as `SystemDouble` and traps.

`TileSortCompareTest.uasm` has the same pattern:

```text
code: %SystemDouble, null
...
PUSH, __t61
PUSH, code
COPY
...
PUSH, code
PUSH, __tcast_199
EXTERN, SystemMath.__Truncate__SystemDouble__SystemDouble
```

This explains why the failure appears across most mahjong fixtures: almost all
of them call `Tile.parse`, which contains this `let code: number` assignment
followed by `UdonTypeConverters.toUdonInt(code)`.

## Investigation tasks

1. Disassemble the generated `.uasm` around the earliest failing PC
   (`tile_parse`, `PC: 0x000010C0`) because it is the smallest reproducer and
   fails before any complex yaku/scoring logic.
2. Walk backward from `SystemMath.__Truncate__SystemDouble__SystemDouble` to
   identify the source expression and the heap slots used as input/output.
3. Add a focused unit or VM regression case for:
   `let code: number; code = int32Expr; return UdonTypeConverters.toUdonInt(code);`
   and assert the generated UASM does not raw-copy an Int32 value into a Double
   slot before `SystemMath.Truncate`.
4. Decide whether the correct fix is:
   - insert an Int32→Double conversion when assigning to a `number`/Double
     variable;
   - preserve `let code: number` as Int32 when all writes are integer-only and
     it flows into `toUdonInt`;
   - teach `UdonTypeConverters.toUdonInt` / `CastInstruction` to use tracked
     runtime slot type when the declared type has been widened by a raw copy.
5. Re-run at least `tile_parse`, `tile_counts`, `hand_win_detection`, and one
   scoring fixture to confirm the shared crash is cleared.

## Acceptance criteria

- No mahjong-t2 VM test fails with
  `SystemMath.__Truncate__SystemDouble__SystemDouble`.
- The focused regression test fails before the fix and passes after it.
- Generated UASM for integer-only tile operations does not contain avoidable
  Double truncation on hot paths.

## Fix

Root cause confirmed: `emitCopyWithTracking` in
`src/transpiler/ir/ast_to_tac/helpers/inline.ts` emitted a raw `CopyInstruction`
without numeric coercion when src and dest operand types differed.

Fix (IR-level, in `emitCopyWithTracking`): when the destination slot's numeric
Udon type differs from the source's, and neither is an inline class handle,
insert a `CastInstruction(castTemp: destType, src)` before the `CopyInstruction`.
This produces a correctly-typed intermediate value so the Udon VM heap slot
stores the expected boxed type. The pattern mirrors the existing coercion in
`assignment.ts` for native array element writes.

Regression test added: `Bug 16` in `tests/unit/transpiler/transpiler_known_bugs.test.ts`
— asserts that `SystemConvert.__ToDouble__SystemInt32__SystemDouble` is emitted
when a `number` (Double) variable is assigned from a UdonInt multiplication.

All 962 pre-existing tests continue to pass; the new Bug 16 test also passes.

## Latest verification (2026-05-09)

The latest mahjong-t2 VM run confirms this issue's original symptom is fixed:

- `tile_parse`, `tile_predicates`, `tile_sort_compare`, `tile_dora`,
  `tile_counts`, `dora_calculator`, and `lru_cache` now pass.
- No listed failure reports
  `SystemMath.__Truncate__SystemDouble__SystemDouble`.
- Overall suite improved from **33 failed / 5 passed** to
  **25 failed / 13 passed**.

Residual numeric-slot mismatches still exist in different lowering paths
(recursive stack DataToken boxing and generated get-range loops). Those are
tracked separately in:

- `issues/2026-05-09T013500-recursive-stack-numeric-datatoken-double.md`

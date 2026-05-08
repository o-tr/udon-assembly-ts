---
created: 2026-05-09T01:35:00+09:00
updated: 2026-05-09T01:35:00+09:00
status: open
severity: critical
component: transpiler / numeric coercion / recursive inline stack
related_test: mahjong-t2 VM suite
related_issue: 2026-05-08T123000-math-truncate-double-vm-crash.md
---

# Recursive inline stack boxes Int32-backed `number` locals as Double DataTokens

## Summary

After the broad `SystemMath.Truncate(Double)` and `lru_cache` crashes were
fixed, the dominant remaining hard failure in the mahjong-t2 VM suite is:

```text
VRCSDK3DataDataToken.__op_Implicit__SystemDouble__VRCSDK3DataDataToken
```

The failure appears in yaku/scoring/analysis tests that flow through
`HandAnalyzerDecompositionService.extractAllMelds`. The generated UASM shows
the crash happens while saving local variables into the recursive inline stack.

## Latest observed result

mahjong-t2 VM run at 2026-05-09 01:35 JST:

```text
Tests: 25 failed | 13 passed (38)
```

Representative failures:

- `hand_win_detection`: `PC: 0x001A2DC0`
- `yaku_tanyao`: `PC: 0x001A0378`
- `yaku_pinfu`: `PC: 0x001A038C`
- `scoring_mangan` / `scoring_tsumo`: `PC: 0x001A0AAC`
- `wait_types`: `PC: 0x001A5EF8`

## UASM deep dive

For `YakuTanyaoTest.uasm`, `PC: 0x001A0378` maps to:

```text
1704752     PUSH, k3
1704760     PUSH, __t28353
1704768     EXTERN, __extern_70
...
1704808     PUSH, c1
1704816     PUSH, __t28354
1704824     EXTERN, __extern_70
1704832     PUSH, __inlineRecInst_HandAnalyzerDecompositionService_extractAllMelds_stack_c1
1704840     PUSH, __inlineRecInst_HandAnalyzerDecompositionService_extractAllMelds_sp
1704848     PUSH, __t28354
1704856     EXTERN, __extern_60
```

Relevant declarations:

```text
__extern_60: "VRCSDK3DataDataList.__set_Item__SystemInt32_VRCSDK3DataDataToken__SystemVoid"
__extern_70: "VRCSDK3DataDataToken.__op_Implicit__SystemDouble__VRCSDK3DataDataToken"
k3: %SystemDouble, null
c1: %SystemDouble, null
c2: %SystemDouble, null
c3: %SystemDouble, null
```

The source is `mahjong-t2/src/core/domain/services/HandAnalyzerDecompositionService.ts`:

```ts
const k1 = firstKind;
const k2 = firstKind + 1;
const k3 = firstKind + 2;

const c1 = counts[k1] as number;
const c2 = counts[k2] as number;
const c3 = counts[k3] as number;
```

These locals are declared as TypeScript `number`, so the transpiler allocates
`SystemDouble` slots and the recursive stack save path wraps them through
`DataToken.__op_Implicit__SystemDouble`. Runtime evidence suggests at least
some of these slots are still backed by Int32 values due to integer array /
DataToken unwrapping and raw numeric copies, so the Double DataToken implicit
extern reads the heap slot as the wrong type and traps.

This is a residual of the same numeric-slot mismatch family as
`2026-05-08T123000`, but it occurs in a different lowering path:
recursive-inline frame save/restore + DataToken boxing, not
`SystemMath.Truncate(Double)`.

## Related residual numeric copy symptom

`hand_operations` now gets past the old tile parsing crash but fails at:

```text
SystemInt32.__op_LessThan__SystemInt32_SystemInt32__SystemBoolean
PC: 0x00008B30
Captured logs: ["1m","3"]
```

The UASM around `PC: 0x00008B30` shows a generated get-range loop:

```text
PUSH, __const_127_SystemDouble  ; 0.0
PUSH, __t708                   ; %SystemInt32
COPY
...
PUSH, __t708
PUSH, ...
EXTERN, SystemInt32.__op_LessThan...
```

So the remaining problem is broader than recursive stack boxing: plain
generated helper code can still raw-copy a Double constant/value into an
Int32 slot and later pass that slot to an Int32 extern.

## Investigation tasks

1. Audit all generated helper paths that emit raw `CopyInstruction` directly
   instead of `emitCopyWithTracking` or an explicit numeric coercion:
   recursive stack save/restore, generated get-range/splice loops, and
   conditional/temporary materialisation.
2. Ensure `wrapDataToken` boxes according to the actual value slot type after
   coercion, or inserts a cast to the declared DataToken target before
   selecting `__op_Implicit__SystemDouble`.
3. Add focused regression tests for:
   - recursive inline save of `const c = arr[i] as number` where `arr[i]` is
     Int32-backed;
   - generated get-range loop initialising an Int32 loop bound from `0.0`.
4. Re-run at least `yaku_tanyao`, `hand_win_detection`, `wait_types`, and
   `hand_operations`.

## Acceptance criteria

- No mahjong-t2 VM test fails with
  `VRCSDK3DataDataToken.__op_Implicit__SystemDouble__VRCSDK3DataDataToken`.
- `hand_operations` no longer fails on
  `SystemInt32.__op_LessThan__SystemInt32_SystemInt32__SystemBoolean`.
- Generated UASM does not raw-copy Double values into Int32 slots, nor
  Int32-backed values into Double slots before Double-only externs.


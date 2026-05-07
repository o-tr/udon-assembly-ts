---
created: 2026-05-07T23:20:02+09:00
updated: 2026-05-07T23:20:02+09:00
status: open
severity: high
component: transpiler / IR + structural-union return tracking
related_branch: master
related_test: mahjong-t2 VM `hand_tenpai`, `tenpai_edge`
---

# Tenpai detection produces wrong results (no VM crash, just wrong logs)

## Summary

Two mahjong-t2 VM tests run to completion without crashing — neither hits the
D3-dispatch-miss diagnostic — but both produce semantically wrong results
from the tenpai-analysis pipeline. This is distinct from #024001 (D3 dispatch
cascade) which manifests as a `__op_Implicit__SystemDouble__VRCSDK3DataDataToken`
crash; here the dispatch lands successfully and the wrong value is returned.

## Symptom

```text
VM: hand_tenpai
  Expected logs: ["TENPAI:YES","2","TENPAI:YES","1"]
  Captured logs: ["TENPAI:YES","2","TENPAI:YES","2"]
                                              ^^^ should be "1"

VM: tenpai_edge
  Expected logs: ["TENPAI:YES","2","TENPAI:NO","TENPAI:YES","13"]
  Captured logs: ["TENPAI:YES","2","TENPAI:NO","TENPAI:NO","0"]
                                                  ^^^^^^^^^ ^^^
```

`tenpai_edge`'s last two entries (`TENPAI:YES`/`13`) correspond to a
kokushi-musou (13-orphans) shape — `13` is the tile-acceptance count for the
13-tile wait. The transpiled run misses the wait entirely.

## Suspected root cause

Both tenpai-detection paths flow through `HandAnalyzer.checkTenpai` and
related helpers. The transpile log emits the following warnings repeatedly
along that codepath, on every Yaku entry-point:

```text
[UntrackedStructuralUnionReturn]
  src/core/domain/services/HandAnalyzer.ts:229:12  (untracked variable
    returned as structural union — relying on sibling returns to populate
    the unified return prefix; ensure null narrowing guards this path.)
[UntrackedStructuralUnionReturn]
  src/core/domain/services/HandAnalyzer.ts:872:12  (same)
[UntrackedStructuralUnionReturn]
  src/core/domain/yaku/yakuman/FirstTurnTsumoYaku.ts:45:26  (same)
```

`UntrackedStructuralUnionReturn` (`statement.ts:1717`) fires when a return
expression's value isn't tied to a tracked inline-instance handle, so the
codegen falls back to "sibling-returns populate the prefix" mode. If a
sibling return populates the prefix with a stale or incorrectly-typed value
— or if the null-narrowing the warning suggests is never actually emitted —
the call site sees the wrong fields.

For `hand_tenpai`'s off-by-one, the most likely failure mode is that the
returned object's tile-count field is being read from the wrong sibling's
prefix slot. For `tenpai_edge`'s missing kokushi case, the most likely
failure mode is that the kokushi-detection branch returns a tracked instance
that doesn't match the sibling-prefix layout, so the union narrows to
`null`/`0` and the kokushi result is discarded.

## Where to investigate

1. **The two warning sites** —
   - `mahjong-t2/src/core/domain/services/HandAnalyzer.ts:229` and `:872`.
     Inspect what each branch returns and whether the unified-return prefix
     can actually represent every variant.
2. **Transpiler structural-union return path** —
   - `src/transpiler/ir/ast_to_tac/visitors/statement.ts:1717` (warning emit).
     The warning text says "ensure null narrowing guards this path"; verify
     the codegen actually inserts the null narrowing it advises.
   - The unified-return-prefix populate logic should be cross-checked against
     mixed tracked/untracked sibling-return cases.
3. **Kokushi-musou specific path** (for `tenpai_edge`) — bisect by writing a
   minimal repro that returns a kokushi `WaitInfo` from one branch and a
   standard-form `WaitInfo` from another, and see whether the call site
   reads back the kokushi tile-count correctly.

## Why this is independent of #024001

#024001 fires when D3 dispatch cannot find any matching candidate and returns
a sentinel that crashes downstream. Both `hand_tenpai` and `tenpai_edge`'s
captured logs prove dispatch succeeded (they produced output). The bug here
is in how the return value's structural-union prefix is populated, not in
dispatch resolution.

## Severity

High. Tenpai detection is one of the core mahjong primitives; downstream
yaku/scoring logic depends on it. Two well-formed test cases produce silently
wrong values, which is worse than a hard crash because real users wouldn't
notice until the bug manifested as a scoring discrepancy.

## References

- `src/transpiler/ir/ast_to_tac/visitors/statement.ts:1717` — warning origin
- `mahjong-t2/src/core/domain/services/HandAnalyzer.ts:229,872`
- `mahjong-t2/tests/vm/cases/hand_tenpai.ts`
- `mahjong-t2/tests/vm/cases/analysis/tenpai_edge.ts`
- Related but distinct: #024001 (D3 dispatch crash cascade)

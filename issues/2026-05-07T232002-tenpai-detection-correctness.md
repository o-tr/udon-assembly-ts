---
created: 2026-05-07T23:20:02+09:00
updated: 2026-05-08T05:35:00+09:00
status: fix-pending-vm
severity: high
component: transpiler / IR + structural-union return tracking
related_branch: tenpai-detection-correctness
related_test: mahjong-t2 VM `hand_tenpai`, `tenpai_edge`
fix_commits: 1d703c3, af8adf1, 5433ef2, 46e9ee3
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

## Fix applied (commits 1d703c3–46e9ee3, branch `tenpai-detection-correctness`)

Root cause confirmed and fixed. See details below.

**`untrackedStructuralHandleVars` set** added to `ASTToTACConverter`:

- In `visitVariableDeclaration`: when a local variable is assigned from a named
  operand (Variable or Temporary) that has no `inlineInstanceMap` entry — but
  NOT from a null constant (which is a dead path guarded by TypeScript narrowing)
  — the destination variable is added to `untrackedStructuralHandleVars`.
  The discriminator is `operandTrackingKey()`: returns `undefined` for Constants,
  a name string for Variable/Temporary.

- In `UntrackedStructuralUnionReturn` path (`statement.ts`): `returnTrackingInvalidated`
  is now only set when the returned variable is in `untrackedStructuralHandleVars`.
  This preserves existing safe behavior for null-bound variables while forcing
  D-3 dispatch for genuinely untracked handles. The previous unconditional
  invalidation would have broken the `inline_erased_return` regression test.

- In `saveAndBindInlineParams` (`helpers/inline.ts`): when a non-heap-prefix
  Variable arg has no `inlineInstanceMap` entry and is in
  `untrackedStructuralHandleVars`, its status propagates to the parameter slot,
  covering the case where an untracked handle is forwarded through a parameter
  and returned directly.

Unit tests (961 tests, 96 files) all pass. Udon VM verification pending (requires Unity).

Additional fixes added after code review (commits af8adf1, 5433ef2, 46e9ee3):
- **af8adf1**: Prune set membership: param names added during inline expansion are removed by `restoreInlineParams` (via `addedToUntrackedSet` field on `InlineParamSaveEntry`); monotone-add preserved (no delete in tracked branch after inner-scope shadowing concern). Test extended with `Wrapper.wrap(p)` + `OuterViaWrap` path.
- **5433ef2**: Propagate out of nested static inline expansions: `emitInlineStaticMethod` finally block adds `result.name` to set when inner `returnTrackingInvalidated && returnInstancePrefix !== undefined`.
- **46e9ee3**: Same propagation for instance method calls (`inlineInstanceMethodCallCore` finally block). Reverted `delete(destKey)` from tracked branch (false-negative risk from inner-scope shadowing outweighs false-positive D-3 cost).

## Root cause (confirmed)

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

## Investigation notes (resolved)

1. **The two warning sites** — both confirmed to be the exact pattern: a
   method uses `tryGet(x) ?? fallback` (NC with method-call LHS → NC split
   skipped → Temporary result → no `inlineInstanceMap` entry), assigned to a
   local, then returned from a method that also has a tracked sibling return
   (literal struct). Callers using the tracked sibling's prefix read stale
   field values when the untracked path executed.

2. **Transpiler structural-union return path** — the root cause was not in
   the null-narrowing advice but in `returnTrackingInvalidated` never being
   set for methods with a mix of tracked and untracked returns. Fixed by
   `untrackedStructuralHandleVars` (see "Fix applied" above).

3. **Kokushi-musou path** — same structural pattern; fix covers it because
   `returnTrackingInvalidated = true` causes the entire call site to use D-3
   dispatch, which reads the correct runtime prefix regardless of which return
   path was taken.

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

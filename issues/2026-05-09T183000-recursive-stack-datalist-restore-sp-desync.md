---
created: 2026-05-09T18:30:00+09:00
updated: 2026-05-09T18:30:00+09:00
status: open
severity: critical
component: transpiler / recursive inline stack / DataList save path
related_test: mahjong-t2 VM suite
related_issue: 2026-05-09T133000-recursive-stack-datalist-token-restore.md
---

# Recursive inline stack DataList restore still throws after type-correct prefill

## Summary

After the type-correct prefill fix in
`2026-05-09T133000-recursive-stack-datalist-token-restore.md` (commit
`e8b4037`, merged via PR #238), the mahjong-t2 VM run on 2026-05-09
18:00 JST still reports the same failure count (24 failed | 14 passed)
with `__get_DataList__` as the dominant exception. Per the predecessor
issue's "Residual / follow-up" note, this is the signal for a real
push/pop SP-desync, save-path bypass, or stale-`sp` read — separate
scope from prefill correctness.

## Failure clustering

Multiple distinct test cases crash at the **same byte-offset PC**, which
means the failing site is in shared recursive scaffolding (almost
certainly inside `extractAllMelds`):

| PC | Tests crashing here |
|----|---------------------|
| 0x001B704C | yaku_tanyao, yaku_suit |
| 0x001B705C | score_distribution, scoring_dealer, scoring_honba |
| 0x001B7060 | yaku_pinfu |
| 0x001B7780 | scoring_mangan, scoring_tsumo |
| 0x001C326C | yaku_sequence, yaku_terminal |
| 0x001B013C | yaku_yakuhai |
| 0x001BCF68 | yaku_kuisagari |
| 0x001BE768 | yaku_combination |
| 0x001BF6D4 | yaku_yakuman_extra |
| 0x001C1DE4 | yaku_triplet |
| 0x001C33D4 | hand_win_detection |
| 0x001D2F8C | wait_types |
| 0x001B4264 | scoring_tiers |
| 0x001B693C | yaku_situational |

The PCs cluster narrowly in `0x001Bxxxx` / `0x001Cxxxx` / `0x001Dxxxx`,
all flowing through `HandAnalyzerDecompositionService.extractAllMelds`.

## Hypotheses (in order of expected likelihood)

1. **Save-path bypass.** A reachable assignment to a DataList local
   inside `extractAllMelds` skips the `DataToken.__ctor__VRCSDK3DataDataList`
   re-box before `set_Item`, e.g. when the RHS is a method-return whose
   erased type came back as `Object` or `DataToken` already. The prefill
   ensures *initial* slot tokens are DataList; the save path must
   maintain that invariant on every write.
2. **SP arithmetic mismatch.** Push/pop sites use a different `sp`
   value (off-by-one), causing the pop to read the slot just below or
   above the saved one — which holds a different-type token.
3. **Cross-stack contamination.** Two locals share the same per-local
   stack DataList instance, so writes for one local poison the other.
4. **Stale `sp` after return-site dispatch.** The pop site reads `sp`
   before/after the increment, landing on a slot from an outer frame.

## Investigation tasks

1. In one of the UASM files (e.g. `ScoringManganTest.uasm`), grep every
   `set_Item` call site whose target is
   `__inlineRecInst_HandAnalyzerDecompositionService_extractAllMelds_stack_*`
   and verify each value pushed was wrapped via
   `DataToken.__ctor__VRCSDK3DataDataList` (or another DataList ctor)
   immediately before. The first save site that bypasses re-boxing is
   the bug.
2. For each `__inlineRecInst_..._sp` increment/decrement pair, verify
   the same `sp` value is used for both `set_Item` (push) and
   `get_Item` (pop) within one save→restore round-trip.
3. Add a focused regression that exercises the recursive save→restore
   round-trip for a DataList local through a method-call assignment
   (the path most likely to drop re-boxing).

## Acceptance criteria

- mahjong-t2 VM run shows `__get_DataList__` failure count strictly
  decreasing from the 2026-05-09 18:00 JST baseline (24 failed).
- Static UASM check: every `set_Item` against a recursive-stack
  DataList container is preceded by a DataList-typed DataToken
  construction (or a DataList-typed value passthrough).

## Reference

- Predecessor issue:
  `2026-05-09T133000-recursive-stack-datalist-token-restore.md`
  (prefill correctness — fixed and merged via PR #238)
- VM run log: 2026-05-09 18:00 JST, 24 failed | 14 passed (38)

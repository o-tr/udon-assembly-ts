---
created: 2026-05-09T01:35:03+09:00
updated: 2026-05-09T18:35:00+09:00
status: open
severity: high
component: transpiler / structural union correctness
related_test: mahjong-t2 VM `hand_tenpai`, `tenpai_edge`
related_issue: 2026-05-07T232002-tenpai-detection-correctness.md
---

# Tenpai VM tests regress to wrong logs after crash fixes

## Summary

The latest mahjong-t2 run gets the tenpai tests far enough to produce logs,
but the semantic results are wrong again:

```text
VM: hand_tenpai
Expected: ["TENPAI:YES","2","TENPAI:YES","1"]
Captured: ["TENPAI:YES","2","TENPAI:YES","2"]

VM: tenpai_edge
Expected: ["TENPAI:YES","2","TENPAI:NO","TENPAI:YES","13"]
Captured: ["TENPAI:YES","2","TENPAI:NO","TENPAI:NO","0"]
```

This is the same symptom family as the previously fixed
`2026-05-07T232002-tenpai-detection-correctness.md`, but it has reappeared
after the numeric and DataToken crash fixes changed which paths execute.

## Related context

This regression is directly downstream of the numeric coercion work tracked in
`2026-05-08T123000-math-truncate-double-vm-crash.md`: investigation task 3
checks whether the inserted casts break the structural tracking key chain.

It is also linked from
`2026-05-08T123002-structural-union-dispatch-warning-budget.md`, whose latest
verification section forwards the remaining `UntrackedStructuralUnionReturn`
warnings to this correctness issue.

This is in the same fix cluster as
`2026-05-09T013501-structural-union-object-iswin-dispatch.md`: both issues
center on `untrackedStructuralHandleVars` propagation through the
`HandAnalyzer.ts:229` and `HandAnalyzer.ts:872` structural-union return paths.

## Current warning context

The latest transpile emits 518 warnings (116 unique), all dominated by
`UntrackedStructuralUnionReturn`. The same shared sites appear on every
mahjong yaku/scoring entry point:

- `HandAnalyzer.ts:229:12`
- `HandAnalyzer.ts:872:12`
- `FirstTurnTsumoYaku.ts:45:26`

These are exactly the class of paths that can produce wrong field values when
an untracked structural-union return is treated as a sibling-prefix return.

## Investigation tasks

1. Re-open the prior tenpai focused repros and compare the current generated
   TAC/UASM against the fixed branch described in
   `2026-05-07T232002-tenpai-detection-correctness.md`.
2. Confirm whether `untrackedStructuralHandleVars` is still set for the
   `HandAnalyzer.ts:229` and `HandAnalyzer.ts:872` return paths in the current
   batch/cross-module transpile.
3. Check whether the new numeric coercion casts insert temporaries that break
   the existing tracking key chain, causing a previously invalidated return to
   look tracked or vice versa.
4. Add a regression assertion that the current `hand_tenpai` and `tenpai_edge`
   cases produce the expected logs once VM execution no longer crashes earlier.

## Acceptance criteria

- `VM: hand_tenpai` logs `["TENPAI:YES","2","TENPAI:YES","1"]`.
- `VM: tenpai_edge` logs
  `["TENPAI:YES","2","TENPAI:NO","TENPAI:YES","13"]`.
- The fix does not reintroduce D3 dispatch miss cascades.

## Latest verification (2026-05-09 13:30 JST)

The latest mahjong-t2 VM run still reaches the tenpai tests but produces the
same wrong logs:

```text
VM: hand_tenpai
Expected: ["TENPAI:YES","2","TENPAI:YES","1"]
Captured: ["TENPAI:YES","2","TENPAI:YES","2"]

VM: tenpai_edge
Expected: ["TENPAI:YES","2","TENPAI:NO","TENPAI:YES","13"]
Captured: ["TENPAI:YES","2","TENPAI:NO","TENPAI:NO","0"]
```

Keep this issue open.

## Audit update (2026-05-09 17:20 JST)

Latest local HEAD is `f7c9393` (`Merge pull request #238 from
o-tr/recursive-stack-datalist-token-restore`). The latest recursive-stack
prefill fix does not address the tenpai structural-union correctness path, and
no newer VM output supersedes the 2026-05-09 13:30 JST wrong-log result above.
Keep this issue open until the mahjong-t2 `hand_tenpai` and `tenpai_edge`
fixtures produce the expected logs in VM.

## Latest verification (2026-05-09 17:59 JST)

The latest mahjong-t2 VM run still reaches both tenpai tests and produces the
same wrong logs:

```text
VM: hand_tenpai
Expected: ["TENPAI:YES","2","TENPAI:YES","1"]
Captured: ["TENPAI:YES","2","TENPAI:YES","2"]

VM: tenpai_edge
Expected: ["TENPAI:YES","2","TENPAI:NO","TENPAI:YES","13"]
Captured: ["TENPAI:YES","2","TENPAI:NO","TENPAI:NO","0"]
```

This confirms the issue is unchanged by the recursive-stack prefill work.

## Investigation result (2026-05-09 18:35 JST)

The latest wrong logs have a cache-reuse shape:

- `hand_tenpai` test 2 captures `TENPAI:YES, 2`, exactly matching test 1's
  result shape, instead of the expected tanki single wait.
- `tenpai_edge` test 3 captures `TENPAI:NO, 0`, matching the immediately
  preceding non-tenpai test 2 result shape, instead of kokushi 13-wait tenpai.

`HandAnalyzer.checkTenpai` delegates to
`HandAnalyzerDecompositionService.checkTenpai`, which checks
`this.tenpaiCache.get(cacheKey)` before recomputing:

```ts
const cacheKey = this.generateTenpaiCacheKey(hand);
const cached = this.tenpaiCache.get(cacheKey);
if (cached !== undefined) {
  return cached as TenpaiResult;
}
```

The symptom is therefore consistent with either:

1. different `Hand` values producing the same transpiled `cacheKey`; or
2. cached `TenpaiResult` structural data being returned through an erased
   `unknown`/`DataToken` path without rebuilding the `{ isTenpai, waits }`
   sibling prefix correctly.

This is adjacent to the structural-union return issues, but the immediate
runtime symptom is stale cached result reuse rather than a direct
`SystemObject.__get_*` extern.

### Fix task

Add a focused VM/transpile regression around `checkTenpai` cache behavior:

1. Log or assert the generated `Hand.getCacheKey()` / `generateTenpaiCacheKey`
   for the three failing fixture hands and prove they are distinct in VM.
2. Add a fixture that calls `checkTenpai` twice on one `HandAnalyzer` instance
   with two distinct hands where expected wait counts differ; assert the second
   call is recomputed and does not return the first cached `TenpaiResult`.
3. If keys collide, fix the string-building / cached `_cacheKey` lowering path.
4. If keys are distinct, fix cached structural return reconstruction for
   `return cached as TenpaiResult` so `isTenpai` and `waits` are read from the
   returned value, not from a stale sibling prefix.

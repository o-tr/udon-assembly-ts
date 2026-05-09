---
created: 2026-05-09T01:35:03+09:00
updated: 2026-05-09T13:30:00+09:00
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

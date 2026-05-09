---
created: 2026-05-09T13:30:00+09:00
updated: 2026-05-09T13:30:00+09:00
status: open
severity: critical
component: transpiler / recursive inline stack / DataList restore
related_test: mahjong-t2 VM suite
related_issue: 2026-05-09T013500-recursive-stack-numeric-datatoken-double.md
---

# Recursive inline stack restores DataList locals from non-DataList DataTokens

## Summary

After the numeric recursive-stack crash was fixed, the dominant remaining hard
failure in the mahjong-t2 VM suite moved to:

```text
VRCSDK3DataDataToken.__get_DataList__VRCSDK3DataDataList
```

This appears across yaku/scoring/analysis tests that flow through
`HandAnalyzerDecompositionService.extractAllMelds`. The generated UASM crashes
while restoring DataList locals from recursive inline frame stacks.

## Latest observed result

mahjong-t2 VM run at 2026-05-09 13:30 JST:

```text
Tests: 24 failed | 14 passed (38)
```

Representative failures:

- `hand_win_detection`: `PC: 0x001A44F8`
- `yaku_tanyao`: `PC: 0x001A1AB0`
- `yaku_pinfu`: `PC: 0x001A1AC4`
- `scoring_mangan` / `scoring_tsumo`: `PC: 0x001A21E4`
- `wait_types`: `PC: 0x001A7630`

## UASM deep dive

For `YakuTanyaoTest.uasm`, `PC: 0x001A1AB0` maps to the restore of
`koutsuTiles` from the recursive inline stack:

```text
1710720     PUSH, __inlineRecInst_HandAnalyzerDecompositionService_extractAllMelds_stack_koutsuTiles
1710728     PUSH, __inlineRecInst_HandAnalyzerDecompositionService_extractAllMelds_sp
1710736     PUSH, __t28515
1710744     EXTERN, VRCSDK3DataDataList.__get_Item__SystemInt32__VRCSDK3DataDataToken
1710752     PUSH, __t28515
1710760     PUSH, __t28516
1710768     EXTERN, VRCSDK3DataDataToken.__get_DataList__VRCSDK3DataDataList
1710776     PUSH, __t28516
1710784     PUSH, koutsuTiles
1710792     COPY
```

Relevant declarations:

```text
__inlineRecInst_..._stack_koutsuTiles: %VRCSDK3DataDataList, null
koutsuTiles: %VRCSDK3DataDataList, null
__t28515: %VRCSDK3DataDataToken, null
__t28516: %VRCSDK3DataDataList, null
```

The corresponding save path boxes a DataList local into a DataToken before
storing it in the stack:

```text
PUSH, koutsuTiles
PUSH, __t28472
EXTERN, VRCSDK3DataDataToken.__ctor__VRCSDK3DataDataList__VRCSDK3DataDataToken
PUSH, __inlineRecInst_..._stack_koutsuTiles
PUSH, __inlineRecInst_..._sp
PUSH, __t28472
EXTERN, VRCSDK3DataDataList.__set_Item__SystemInt32_VRCSDK3DataDataToken__SystemVoid
```

The restore site is therefore structurally correct only if every stack slot at
the current `sp` actually contains a DataList token. The VM crash indicates the
token at that index can be null or can contain a non-DataList value.

## Relationship to nearby issues

This is distinct from
`2026-05-09T013500-recursive-stack-numeric-datatoken-double.md`: the old
failure was numeric DataToken boxing (`__op_Implicit__SystemDouble`), while
this one is DataList token unwrapping during frame restore.

It is also distinct from
`2026-05-09T013502-recursive-structural-list-return-null.md`: that issue
tracks a null recursive return DataList read via `.Count`; this issue tracks
recursive frame local restoration via `DataToken.__get_DataList`.

## Investigation tasks

1. Trace the `sp` value around recursive self-call save/restore for
   `extractAllMelds`, especially around `koutsuTiles`, `results`,
   `subResults`, and `shuntsuTiles`.
2. Verify every DataList local stack is prefilled with DataList tokens for all
   possible frame depths, not null tokens.
3. Check whether any stack field uses a stale `sp` after return-site dispatch
   or underflow/overflow handling.
4. Add a focused regression with a recursive inline method that saves and
   restores a DataList local across a self-call.
5. Re-run `yaku_tanyao`, `hand_win_detection`, `wait_types`, and one scoring
   fixture.

## Acceptance criteria

- No mahjong-t2 VM test fails with
  `VRCSDK3DataDataToken.__get_DataList__VRCSDK3DataDataList`.
- Recursive inline stack restore only unwraps DataList tokens from slots that
  were initialised or saved as DataList tokens for the active frame.

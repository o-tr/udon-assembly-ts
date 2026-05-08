---
created: 2026-05-09T01:35:02+09:00
updated: 2026-05-09T01:35:02+09:00
status: open
severity: high
component: transpiler / recursive inline returns / DataList
related_test: mahjong-t2 VM suite
---

# Recursive `extractAllMelds` return can leave DataList result null

## Summary

Two remaining mahjong-t2 VM failures crash when reading `.Count` from a
DataList returned by the recursive `extractAllMelds` path:

```text
VRCSDK3DataDataList.__get_Count__SystemInt32
```

This is distinct from the `DataToken.__op_Implicit__SystemDouble` crash in the
same source area: the recursive call returns to the caller, but the returned
DataList slot is null when the caller starts iterating.

## Latest observed failures

mahjong-t2 VM run at 2026-05-09 01:35 JST:

- `yaku_triplet`: `PC: 0x004A45B0`
- `yaku_yakuman_extra`: `PC: 0x00494C48`

## UASM deep dive

For `YakuTripletTest.uasm`, `PC: 0x004A45B0` maps to:

```text
4867448 inline_rec_done46667:
4867448     PUSH, __inlineRecInst_HandAnalyzerDecompositionService_extractAllMelds_retVal_79595
4867456     PUSH, allMeldCombinations
4867464     COPY
4867468     PUSH, __const_3_SystemInt32
4867476     PUSH, __t80631
4867484     COPY
4867488     PUSH, allMeldCombinations
4867496     PUSH, __t80632
4867504     EXTERN, __extern_5
```

`__extern_5` is:

```text
VRCSDK3DataDataList.__get_Count__SystemInt32
```

The source is the loop over the recursive result in
`HandAnalyzerDecompositionService.extractAllMelds`:

```ts
const subResults = this.extractAllMelds(...);
for (const subResult of subResults) {
  ...
}
```

The caller expects the recursive inline return slot to always contain a
DataList, including the base case (`return [[]]`) and no-result case
(`return []`). The generated slot
`__inlineRecInst_..._retVal_79595` can still be null at the merge point.

## Investigation tasks

1. Trace all return sites in the recursive lowering of
   `extractAllMelds`: base case `return [[]]`, cache hit, no-first-kind
   `return []`, koutsu/shuntsu result returns.
2. Verify every recursive return site initialises the same retVal slot before
   jumping to `inline_rec_done`.
3. Check whether early return through cache/untracked structural union paths
   bypasses the retVal assignment.
4. Add a minimal recursive inline regression where a method returns `T[][]`
   and the caller immediately iterates the result.
5. Re-run `yaku_triplet` and `yaku_yakuman_extra`.

## Acceptance criteria

- No mahjong-t2 VM test fails on
  `VRCSDK3DataDataList.__get_Count__SystemInt32` from a null recursive return.
- Recursive inline methods returning arrays/DataLists initialise retVal on
  every return path.


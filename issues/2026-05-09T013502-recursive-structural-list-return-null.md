---
created: 2026-05-09T01:35:02+09:00
updated: 2026-05-09T18:07:00+09:00
status: open
severity: high
component: transpiler / recursive inline returns / DataList
related_test: mahjong-t2 VM suite
related_issue: 2026-05-08T123000-math-truncate-double-vm-crash.md
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

## Fix tasks

1. Fix recursive inline return assignment so a `DataToken` source returned to a
   `DataList`/array retVal is unwrapped with
   `VRCSDK3DataDataToken.__get_DataList__VRCSDK3DataDataList`, not raw-copied.
2. Apply the same typed return coercion to cache-hit and other early-return
   sites in recursive inline methods before they write to the shared retVal.
3. Add a focused regression where a recursive inline method returning `T[][]`
   has a cache-hit branch stored as `DataToken`, then the caller immediately
   iterates the returned list.
4. Re-run `yaku_triplet` and `yaku_yakuman_extra`.

## Previous root cause (fixed)

Both `emitInlineRecursiveInstanceMethod` and `emitInlineRecursiveStaticMethod`
left the `retVal` slot uninitialised in the preamble. Two structural gaps meant
`retVal` could be null when the caller read it at `inline_rec_done`:

1. **Overflow handler** — logs error, resets depth/sp, then `goto doneLabel`
   without setting retVal.
2. **End-of-body fallthrough** — after the method body, jumps back to
   `dispatchLabel` without setting retVal (dispatch index 0 falls through to
   doneLabel).

Self-calls bypass the preamble by jumping directly to `entryLabel`, so only
the outermost invocation needs the initialisation.

## Fix (2026-05-09)

In both emitters, after the SP-reset block and before the overflow handler,
emit a `CopyInstruction(result, createSoaSentinelValue(converter, effectiveReturnType))`
for non-void, non-erased return types. For DataList/Array types this constructs
an empty `DataList`; for primitives it uses 0/false/"". This covers both
structural gaps in a single initialisation point.

Files changed:
- `src/transpiler/ir/ast_to_tac/helpers/inline.ts`: apply fix to both
  `emitInlineRecursiveStaticMethod` and `emitInlineRecursiveInstanceMethod`
- `tests/unit/transpiler/inline_outline.test.ts`: regression test
  "initialises retVal before overflow handler for T[][] return type"

## Acceptance criteria

- No mahjong-t2 VM test fails on
  `VRCSDK3DataDataList.__get_Count__SystemInt32` from a null recursive return.
- Recursive inline methods returning arrays/DataLists initialise retVal on
  every return path.

## Latest verification (2026-05-09 13:30 JST)

The latest mahjong-t2 VM run still has two failures on
`VRCSDK3DataDataList.__get_Count__SystemInt32`:

- `yaku_triplet`: `PC: 0x004A72CC`
- `yaku_yakuman_extra`: `PC: 0x00497964`

The earlier fix moved the PCs but did not eliminate this failure family. Keep
this issue open until the Count failures disappear.

The broader recursive stack now also fails when restoring DataList locals via
`DataToken.__get_DataList__VRCSDK3DataDataList`; that separate stack
save/restore path is tracked in:

- `issues/2026-05-09T133000-recursive-stack-datalist-token-restore.md`

## Static follow-up investigation (2026-05-09)

The retVal preamble fix from PR #231 is present on `master`:

- `emitInlineRecursiveStaticMethod` initialises `retVal` after SP reset and
  before the overflow handler.
- `emitInlineRecursiveInstanceMethod` applies the same initialisation.
- Self-calls jump directly to `entryLabel`, so this preamble only affects the
  outermost invocation as intended.

Local validation:

- `pnpm test` passed for 102 files / 989 tests.
- The `inline_outline.test.ts` recursive `T[][]` regression passes for both
  static and instance methods.
- A direct `Solver.solve(): number[][]` transpile shows `retVal_1 =
  DataList.ctor()` in the preamble and writes to `retVal_1` on each return
  path.
- No nested-inline guard was found that would skip emitting the preamble inside
  `emitInlineRecursive*Method`.

Conclusion: the original uninitialised-preamble gap is covered by the merged
fix, but the mahjong-t2 VM still observes a `DataList.__get_Count` crash at new
PCs. The current PC mapping below shows the remaining fix target is a cache-hit
return path that raw-copies a `DataToken` into a `DataList` retVal.

## Current PC analysis (2026-05-09)

`YakuTripletTest.uasm` at the current `PC: 0x004A72CC` maps to the caller's
iteration over the recursive result:

```text
4878996 inline_rec_done46667:
4878996     PUSH, __inlineRecInst_HandAnalyzerDecompositionService_extractAllMelds_retVal_79932
4879004     PUSH, allMeldCombinations
4879012     COPY
4879036     PUSH, allMeldCombinations
4879044     PUSH, __t80992
4879052     EXTERN, VRCSDK3DataDataList.__get_Count__SystemInt32
```

`YakuYakumanExtraTest.uasm` at `PC: 0x00497964` has the same shape:

```text
4815148 inline_rec_done45675:
4815148     PUSH, __inlineRecInst_HandAnalyzerDecompositionService_extractAllMelds_retVal_78769
4815156     PUSH, allMeldCombinations
4815164     COPY
4815188     PUSH, allMeldCombinations
4815196     PUSH, __t79829
4815204     EXTERN, VRCSDK3DataDataList.__get_Count__SystemInt32
```

The remaining bad write is the cache-hit return path. `cached` is declared as
`%VRCSDK3DataDataToken`, but the generated code copies it directly into a
`%VRCSDK3DataDataList` temporary and then into retVal:

```text
cached: %VRCSDK3DataDataToken, null
__t80015: %VRCSDK3DataDataList, null

PUSH, cached
PUSH, __t80015
COPY
PUSH, __t80015
PUSH, __inlineRecInst_HandAnalyzerDecompositionService_extractAllMelds_retVal_79932
COPY
```

That raw `DataToken -> DataList` copy bypasses the `DataToken.DataList`
unwrap/coercion path. The fix should target recursive inline return assignment
coercion for typed retVal writes, not additional return-site discovery.

## Audit update (2026-05-09 17:20 JST)

Latest local HEAD is `f7c9393` (`Merge pull request #238 from
o-tr/recursive-stack-datalist-token-restore`). PR #238 fixed type-correct
recursive stack prefill, which is adjacent but not the cache-hit return
assignment path identified here. No newer mahjong-t2 VM run is recorded after
the 2026-05-09 13:30 JST failures, so keep this issue open. Next fix target is
still typed recursive inline retVal writes when the returned source is a
`DataToken` and the effective return type is `DataList` / array.

## Latest verification (2026-05-09 17:59 JST)

The latest mahjong-t2 VM run no longer reports
`VRCSDK3DataDataList.__get_Count__SystemInt32` in the visible failure list.
The formerly Count-failing fixtures now fail earlier or differently with
`VRCSDK3DataDataToken.__get_DataList__VRCSDK3DataDataList`:

- `yaku_triplet`: `PC: 0x001C1DE4`
- `yaku_yakuman_extra`: `PC: 0x001BF6D4`

This does not prove the Count-path issue is fixed; it is currently masked by
the broader recursive stack restore failure tracked in
`2026-05-09T133000-recursive-stack-datalist-token-restore.md`. Keep this issue
open until the DataToken/DataList restore crash is gone and `yaku_triplet` /
`yaku_yakuman_extra` can reach the recursive return iteration path again.

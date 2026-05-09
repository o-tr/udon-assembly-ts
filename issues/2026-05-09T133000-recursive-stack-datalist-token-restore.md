---
created: 2026-05-09T13:30:00+09:00
updated: 2026-05-09T15:00:00+09:00
status: fixed
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

## Root cause

`emitInlineRecursiveStaticMethod` and `emitInlineRecursiveInstanceMethod` were
prefilling every per-local stack with the same Double(0) DataToken,
regardless of the local's actual type. Created once outside the loop:

```ts
const defaultToken = converter.wrapDataToken(
  createConstant(0, PrimitiveTypes.double),
);
for (const stackVarInfo of stackVars) { ... Add(defaultToken) x16 }
```

For DataList-typed locals (`koutsuTiles`, `shuntsuTiles`, `results`,
`subResults`, `selfCallResult_<i>` for DataList-returning methods), the pop
site emits `DataToken.__get_DataList__` against `stack[sp]`. If pop ever
reads a slot whose stored token's `TokenType` is not `DataList`, the VM
throws on the getter. The shared Double prefill made every never-pushed slot
a guaranteed crash if it was read — and the mahjong-t2 traces show this is
exactly what `extractAllMelds` exercises.

`@RecursiveMethod` in `statement.ts` had the same defensive gap with a
shared Single(0) prefill.

## Fix

A new helper `makeDefaultDataTokenForLocal(converter, localType)` mirrors
the type→accessor switch in `unwrapDataToken`:

- `DataList` / `Array` → construct a fresh empty `DataList` and wrap via
  `DataToken.__ctor__VRCSDK3DataDataList` (matches `.DataList` getter).
- `DataDictionary` → fresh empty `DataDictionary`, wrapped via
  `DataToken.__ctor__VRCSDK3DataDataDictionary`.
- `Boolean` → `DataToken.__ctor__SystemBoolean(false)`.
- `Int32` family (`Int16`/`UInt16`/`UInt32`/`Byte`/`SByte`) →
  `DataToken.__ctor__SystemInt32(0)` (matches `.Int` getter).
- `Int64` / `UInt64` → `DataToken.__ctor__SystemInt64(0n)` (matches `.Long`).
- `Single` / `Double` → `DataToken.__op_Implicit__SystemSingle/Double(0)`
  (the SDK ctor for `Single` is broken; op_Implicit is the verified path
  and is consistent with how non-prefill saves are emitted).
- `String` → `DataToken.__ctor__SystemString("")`.
- Inline class handle → `DataToken.__ctor__SystemInt32(-1)` (matches the
  `-1` null sentinel selected by `unwrapDataToken` for inline handles).
- Reference / Object / unknown → fallback to `Double(0)` (out of scope of
  this issue; `unwrapDataToken` short-circuits `ObjectTypeSymbol` and
  `GenericTypeParameterSymbol` before reaching the `Reference` branch).

Both inline-recursive prefills (`emitInlineRecursive{Static,Instance}Method`)
and `@RecursiveMethod`'s prefill in `statement.ts` now construct the
default token per stack with this helper rather than sharing one token
across all stacks.

Files changed:

- `src/transpiler/ir/ast_to_tac/helpers/inline.ts` — add
  `makeDefaultDataTokenForLocal` and convert both inline-recursive prefill
  loops to per-local default tokens.
- `src/transpiler/ir/ast_to_tac/visitors/statement.ts` — apply the helper
  to the `@RecursiveMethod` prefill block as well.
- `tests/unit/transpiler/recursive_stack_datalist_prefill.test.ts` — new
  regression covering both `emitInlineRecursiveStaticMethod` and
  `emitInlineRecursiveInstanceMethod`. Asserts each per-local stack's
  prefill ctor matches the local's TypeSymbol (DataList ctor for DataList
  locals, op_Implicit for `number`-typed parameters, DataList ctor for
  the synthesized `selfCallResult_0` slot when the recursive method
  returns DataList).

Commit: `e8b4037` — "Type-correct prefill for recursive stack slots".

## Verification (without VM)

A reproducer modelled on `HandAnalyzerDecompositionService.extractAllMelds`
(instance recursion with `tiles`, `koutsuTiles`, `shuntsuTiles`, `results`,
`subResults` DataList locals + `depth: number`) was transpiled and the
generated UASM cross-checked. For every per-local stack, the prefill ctor
was confirmed to agree with the pop accessor:

| stack | prefill ctor | pop accessor |
|-------|-------------|--------------|
| `tiles` | `__ctor__VRCSDK3DataDataList` | `__get_DataList__` |
| `depth` | `__op_Implicit__SystemDouble` | `__get_Double__` |
| `koutsuTiles` | `__ctor__VRCSDK3DataDataList` | `__get_DataList__` |
| `shuntsuTiles` | `__ctor__VRCSDK3DataDataList` | `__get_DataList__` |
| `results` | `__ctor__VRCSDK3DataDataList` | `__get_DataList__` |
| `subResults` | `__ctor__VRCSDK3DataDataList` | `__get_DataList__` |
| `returnSiteIdx` | `__ctor__SystemInt32` | `__get_Int__` (with null guard) |
| `selfCallResult_0` | `__ctor__VRCSDK3DataDataList` | `__get_DataList__` |

Pre-fix, every row's prefill column would have been
`__op_Implicit__SystemDouble` regardless of the unwrap accessor.

Other static checks on the same UASM:

- `koutsuTiles` slot stays `%VRCSDK3DataDataList`; pop reads
  `%VRCSDK3DataDataToken` and unwraps to `%VRCSDK3DataDataList` (matches
  the `PC: 0x001A1AB0` failing sequence from the issue's UASM deep dive,
  but now the input token is DataList-typed by construction).
- All six `__get_DataList__` call sites take a `%VRCSDK3DataDataToken`
  input and write a `%VRCSDK3DataDataList` output.
- `set_Item` (push) and `get_Item` (pop) on `stack_koutsuTiles` are
  balanced (1:1) per call site.
- The prefill `Add` for `stack_koutsuTiles` precedes the first push's
  `set_Item` in the code section (init order is correct).

VM verification (acceptance criterion 1, `mahjong-t2 VM suite`) is
out-of-scope of this fix run and remains for the next VM batch.

## Residual / follow-up

- VM run not executed in this iteration. If `__get_DataList__` failures
  persist after the next mahjong-t2 VM run, that is the signal for a real
  push/pop SP-desync (issue investigation tasks #1 and #3) — separate
  scope from this prefill correctness fix.

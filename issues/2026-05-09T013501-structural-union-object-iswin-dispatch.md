---
created: 2026-05-09T01:35:01+09:00
updated: 2026-05-09T13:30:00+09:00
status: open
severity: high
component: transpiler / structural union returns / D3 dispatch
related_test: mahjong-t2 VM suite
related_issue: 2026-05-07T232002-tenpai-detection-correctness.md
---

# Structural-union result is erased to `SystemObject`, causing `__get_isWin` extern

## Summary

Several remaining mahjong-t2 failures no longer crash in numeric coercion.
Instead, a structural-union result is copied into an erased `SystemObject`
handle and property access emits an impossible extern:

```text
SystemObject.__get_isWin__SystemBoolean
```

Unity reports:

```text
NotSupportedException: Function '__get_isWin__SystemBoolean' is not implemented yet
```

This appears with many repeated runtime diagnostics:

```text
[Error] [udon-assembly-ts] D3 method dispatch miss: check on untracked instance
```

## Latest observed failures

mahjong-t2 VM run at 2026-05-09 01:35 JST:

- `yaku_yakuman`: `SystemObject.__get_isWin__SystemBoolean`, `PC: 0x0075B2C0`
- `win_chiitoitsu`: `SystemObject.__get_isWin__SystemBoolean`, `PC: 0x0075B158`
- `scoring_fu`: `SystemObject.__get_isWin__SystemBoolean`, `PC: 0x0075CE28`

## UASM deep dive

For `YakuYakumanTest.uasm`, `PC: 0x0075B2C0` maps to:

```text
7713436 inline_return3775:
7713436     PUSH, __inline_ret_6661
7713444     PUSH, result1
7713452     COPY
7713456     PUSH, result1
7713464     PUSH, __t124427
7713472     EXTERN, __extern_123
```

Relevant declarations:

```text
result1 / __inline_ret_6661: structural result handle path
__extern_123: "SystemObject.__get_isWin__SystemBoolean"
```

Nearby declarations show both a typed field prefix and an erased object handle
exist for the same structural result family:

```text
chiitoitsuWin: %SystemObject, null
chiitoitsuWin_isWin: %SystemBoolean, null
standardWin_isWin: %SystemBoolean, null
```

The lowering therefore has the data needed in sibling prefix fields, but the
final property access on `result1.isWin` is going through `SystemObject`
instead of either:

- the structural prefix field (`result1_isWin` / copied sibling prefix), or
- D3 dispatch to the concrete runtime structural instance.

## Why this is separate from the prior tenpai fix

`2026-05-07T232002-tenpai-detection-correctness.md` fixed one class of
untracked structural union return by invalidating tracking and falling back to
D3 dispatch. The latest output shows a new or regressed path where:

1. the returned value is still erased to `SystemObject`;
2. field-prefix copies exist;
3. the property access does not use them; and
4. D3 dispatch miss diagnostics are emitted repeatedly for related checks.

## Related context

This issue is also a follow-up from
`2026-05-08T123002-structural-union-dispatch-warning-budget.md`: that issue's
latest verification section points here because the remaining
`UntrackedStructuralUnionReturn` warnings now correlate with runtime
structural-union correctness failures, not just warning-budget noise.

It is in the same fix cluster as
`2026-05-09T013503-tenpai-correctness-regression.md`: both issues investigate
`untrackedStructuralHandleVars` propagation through the `HandAnalyzer.ts:229`
and `HandAnalyzer.ts:872` structural-union return paths.

## Investigation tasks

1. Trace `result1` / `__inline_ret_6661` in `YakuYakumanTest.uasm` back to the
   corresponding inlined method return and determine where its structural
   field prefix is lost.
2. Verify `returnTrackingInvalidated` and `untrackedStructuralHandleVars`
   propagation through nested inline return sites around the `standardWin` /
   `chiitoitsuWin` merge.
3. Prevent property access codegen from emitting `SystemObject.__get_<prop>`
   for structural-union fields. It should either read the unified structural
   prefix or force D3 dispatch.
4. Add a regression test with a structural union result containing `isWin`
   where one branch is a tracked literal and another branch flows through an
   erased inline return.
5. Re-run `yaku_yakuman`, `win_chiitoitsu`, and `scoring_fu`.

## Acceptance criteria

- No generated UASM contains `SystemObject.__get_isWin__SystemBoolean`.
- The listed tests no longer fail with `NotSupportedException:
  Function '__get_isWin__SystemBoolean' is not implemented yet`.
- The D3 dispatch miss diagnostics for `check on untracked instance` do not
  appear in these tests.

## Root cause (identified 2026-05-09)

The bug occurs through a sequence of three issues:

1. **Untracked NC return**: `WinAnalyzer.tryWin` uses `tryGet(x) ?? fallback`
   where `tryGet` is a method call. `isSideEffectFreeNullCoalesceLeft = false` →
   NC split skipped → result is an untracked Temporary → `returnTrackingInvalidated = true`
   → the returnVar is NOT in `inlineInstanceMap`.

2. **Caller also untracked**: `Outer.analyze` returns the untracked result from
   `tryWin` → `UntrackedStructuralUnionReturn` → `returnTrackingInvalidated = true`.
   The LAST return (tracked literal) does NOT write field copies because tracking was
   already invalidated → `returnVar_isWin` never enters `symbolTable` →
   `sourcePrefixFromNamedSlots = false` in caller → caller's variable goes to
   `untrackedStructuralHandleVars`, NOT `inlineInstanceMap`.

3. **Dispatch limit exceeded**: Property access on the untracked variable falls to
   D3 dispatch. The `anonUnionIface` path (for `type WinResult = StandardWin | ChiitoitsuWin`
   → `__anon_union_N`) matches the concrete instances. But `usedErasedFallback` was
   `false` for this path → dispatch limit stayed at `DEFAULT_DISPATCH_LIMIT = 100`.
   In the mahjong program, `dispInstances.length > 100` → dispatch block skipped entirely,
   including the miss path → silent fallthrough to `PropertyGetInstruction` →
   `SystemObject.__get_isWin__SystemBoolean`.

## Fix (2026-05-09)

Two changes in `src/transpiler/ir/ast_to_tac/`:

**`dispatch_limit_resolver.ts`**:
- Added `isStructuralUnionDispatch?: boolean` to `DispatchLimitContext`
- `createDefaultDispatchLimitResolver().getLimit()` returns `LARGE_ERASED_DISPATCH_LIMIT`
  (512) when `isStructuralUnionDispatch = true`

**`visitors/expression.ts`** (3 changes):
- Track `usedAnonUnionIface = anonUnionIface !== null && dispInstances.length > 0` after
  the initial instance loop
- Pass `isStructuralUnionDispatch: usedAnonUnionIface` to `getLimit()`; update warning
  guard to `(usedErasedFallback || usedAnonUnionIface)`
- Update miss-path condition inside the dispatch block from `if (usedErasedFallback)` to
  `if (usedErasedFallback || usedAnonUnionIface)`
- Add `else if (dispInstances.length > dispatchLimit && (usedErasedFallback || usedAnonUnionIface))`
  safety-net branch that emits `Debug.LogError` + zero-init result and returns instead
  of falling through to `PropertyGetInstruction`

## Latest verification (2026-05-09 13:30 JST)

The latest mahjong-t2 VM run still reports `SystemObject.__get_isWin` failures:

- `yaku_yakuman`: `NotSupportedException: Function '__get_isWin__SystemBoolean' is not implemented yet`, `PC: 0x00761E7C`
- `win_chiitoitsu`: same `__get_isWin` failure, `PC: 0x00761D14`
- `scoring_fu`: same `__get_isWin` failure, `PC: 0x007639E4`

The attempted dispatch-limit fix moved the PCs but did not eliminate the
fallback to `SystemObject.__get_isWin__SystemBoolean`. Keep this issue open.

**Tests added** (`tests/unit/transpiler/structural_union_iswin_dispatch.test.ts`):
- 3-case regression test covering: NC method-call-LHS untracked path, param-forwarding
  path, and limit-exceeded path (tiny `dispatchLimitResolver.getLimit = () => 1`).
  All 3 assert no `__get_isWin` extern.

All 978 unit tests pass. Latest VM verification above shows the mahjong-t2 VM
path still falls back to `SystemObject.__get_isWin__SystemBoolean`, so this
issue remains open.

## Known caveat

`hasCompatibleUnionProperty` admits any concrete class whose `isWin` property is
structurally equal to the union's `isWin` — it does not check that the class is an
actual union member. In programs with many unrelated classes sharing a property name
and type, the 512-instance dispatch table could still be exhausted. The safety-net
`else if` branch prevents the invalid EXTERN in that case, but returns a zero-init
value and emits a runtime diagnostic.

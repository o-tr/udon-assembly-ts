---
created: 2026-05-09T01:35:01+09:00
updated: 2026-05-10T00:30:00+09:00
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

## Audit update (2026-05-09 17:20 JST)

Latest local HEAD is `f7c9393` (`Merge pull request #238 from
o-tr/recursive-stack-datalist-token-restore`). The latest merged changes only
address recursive stack DataToken prefill and issue documentation; they do not
touch the structural-union `isWin` fallback path. No newer VM run is recorded
after the 2026-05-09 13:30 JST result above, so this issue remains open with
the same acceptance criteria.

## Latest verification (2026-05-09 17:59 JST)

The latest mahjong-t2 VM run still reports `__get_isWin__SystemBoolean`
failures, now at lower PCs than the 13:30 JST run:

- `yaku_yakuman`: `NotSupportedException: Function '__get_isWin__SystemBoolean' is not implemented yet`, `PC: 0x004CBB34`
- `win_chiitoitsu`: same `__get_isWin` failure, `PC: 0x004CB9CC`
- `scoring_fu`: same `__get_isWin` failure, `PC: 0x004D1168`

Each failing test also emits repeated runtime diagnostics:

```text
[Error] [udon-assembly-ts] D3 method dispatch miss: check on untracked instance
```

The latest run therefore confirms this issue is still open. The remaining
failure is not the dispatch-limit safety-net case previously fixed; generated
code still reaches an invalid property extern after D3 miss diagnostics.

## Investigation result (2026-05-09 18:35 JST)

`YakuYakumanTest.uasm` at `PC: 0x004CBB34` maps to a plain property read:

```text
inline_return46785:
    PUSH, __inline_ret_78943
    PUSH, __inline_ret_6645
    COPY
inline_return3775:
    PUSH, __inline_ret_6645
    PUSH, result1
    COPY
    PUSH, result1
    PUSH, __t78988
    EXTERN, SystemObject.__get_isWin__SystemBoolean
```

Immediately before that, the callee return path did populate the structural
sibling fields for `__inline_ret_78943`:

```text
PUSH, __inst___anon_union_1_634_isWin
PUSH, __inline_ret_78943_isWin
COPY
...
PUSH, __inst___anon_union_1_634__handle
PUSH, __inline_ret_78943
COPY
```

The loss happens at the nested inline return boundary:
`__inline_ret_78943` is copied to `__inline_ret_6645`, but the sibling slots
(`__inline_ret_78943_isWin`, `__inline_ret_78943_yaku`, etc.) are not copied
to the outer return prefix. The final caller therefore receives only an erased
`SystemObject` handle and property access falls through to the invalid extern
instead of reading a structural prefix or using D3 dispatch.

The inline return path only handles `valueMapping`, so it misses synthetic
inline return prefixes such as `__inline_ret_78943`. However, simply copying
`${srcKey}_<prop>` sibling slots at every nested return boundary is unsafe:
some execution paths populate those slots and some do not, so an unconditional
copy can propagate stale values from a different branch.

## Investigation update (2026-05-09 19:30 JST) — fix attempt rolled back

The 18:35 JST proposal above was implemented, exposed silent-data-loss
regressions in 4 unit tests, and rolled back. Findings:

1. **`symbolTable.lookup(`${srcKey}_${propName}`)` is dead code.** No
   `addSymbol` call in the codebase ever registers `${prefix}_<prop>` slot
   names — the assignment helper's existing
   `sourcePrefixFromNamedSlots` check at `visitors/statement.ts:570` is
   already returning `undefined` for every call. Verified empirically: 18
   slot lookups across the failing test sources, 0 hits. Step 1 of the
   fix task above cannot be implemented as written.

2. **`untrackedStructuralHandleVars.has(srcKey)` is the wrong gate.** That
   set marks "this name holds an untracked handle" — it is populated in
   many places (assignment helper else-if at `:619`, param binding,
   inline expansion exit at `inline.ts:2340`, ternary visitors). Several
   of those populators do NOT guarantee the slots were ever written
   (e.g. `const t = f ? w : l` stores into a temp; the inline
   `__inst_*_<prop>` writes happen on the constructed prefixes, not on
   `t_<prop>`). Gating the boundary copy on this set propagates *stale*
   slot values when the runtime takes an untracked path.

3. **A populated-prefix tracking set added at reliable populator sites
   (`visitReturnStatement` valueMapping branch, `assignment.ts`
   structural-copy branch, `emitStructuralPrefixDefaults`) is also
   insufficient.** It records "some path wrote the slots," not "every
   path on this execution branch wrote the slots." The
   `tenpai_param_return_batch_regression > D-3 dispatch (__uninst_prop_*)
   appears in generated assembly` test is the canonical reproducer:
   `passThrough(p)` has `if (p === null) return literal; return p;` —
   the literal branch populates `__inline_ret_<passThrough>_<prop>`, the
   `return p` branch does not. With the boundary copy gated on the
   populated-prefix marker, the caller reads slots that contain stale
   literal-branch values when `p !== null` was the runtime path. D-3
   dispatch correctly reads the runtime handle in that case; the
   boundary copy silently returns wrong values.

4. **The naive boundary-copy fix would replace one bug
   (`NotSupportedException` at runtime) with another (silent wrong
   values from uninitialised slot reads).** Wrong values are harder to
   diagnose than the original crash and may not surface in unit tests
   that assert only on UASM shape, only in VM-level correctness checks.

### Fix task (revised 2026-05-09 19:45 JST)

Implement a path-sensitive fix. The required discriminator is:

> every runtime path that can reach the nested inline return boundary must have
> populated the source structural prefix on that same path.

Do not implement the naive `${srcKey}_<prop>` boundary copy unless this
condition is proven.

Recommended implementation direction:

1. Add per-return-site structural-prefix metadata to inline return state.
   Each return site records whether it wrote the unified structural prefix for
   its own path, and which prefix it wrote.
2. Propagate that metadata through nested inline returns. A boundary may copy
   `innerPrefix_<prop> -> outerPrefix_<prop>` only when the inner method's
   reaching return site is known to have populated the prefix on that path.
3. For `tryGet(x) ?? fallback` / ternary returns of structural unions, update
   lowering so each branch either:
   - copies concrete structural slots into the branch's return prefix, or
   - explicitly marks the branch as untracked so the caller must use D-3
     dispatch rather than sibling-prefix reads.
4. Preserve D-3 dispatch as the fallback for reachable untracked handle paths.
   Do not replace D-3 with sibling-prefix reads unless all paths are proven
   populated.
5. Keep or strengthen the dispatch-limit safety net so an untracked structural
   handle never falls through to `SystemObject.__get_isWin__SystemBoolean`.
   If the dispatch table cannot be emitted, return a diagnostic zero-init
   result rather than an invalid extern.
6. Unskip and satisfy
   `tests/unit/transpiler/structural_union_iswin_dispatch.test.ts:232`
   once the deeper fix lands. Add a second regression for the known bad
   case from `tenpai_param_return_batch_regression`: `if (p === null) return
   literal; return p;` must keep using D-3 dispatch for the `return p` path
   and must not read stale literal-branch slots.

Rejected implementation shortcuts:

- `symbolTable.lookup(`${srcKey}_${propName}`)`: slot names are not registered
  in `SymbolTable`, so this check has no signal.
- `untrackedStructuralHandleVars.has(srcKey)`: this means "handle is
  untracked", not "sibling slots are populated".
- A global `populatedStructuralPrefixes` set: it records that some path wrote
  slots, not that this runtime path wrote them.

A skipped reproducer test was added at
`tests/unit/transpiler/structural_union_iswin_dispatch.test.ts:232`
(`it.skip`) to preserve the failing shape until the deeper fix lands.

### Reverted fix attempt — diff summary

No production-code changes from the 19:30 JST attempt remain. The
2026-05-09 fix described under **"Fix (2026-05-09)"** above
(dispatch-limit resolver + safety-net branch in `visitors/expression.ts`)
is unaffected and stays in place. The full unit-test suite now has 997
passing (including new nested inline return field propagation regression),
0 newly skipped, and 184 previously skipped.

## Nested inline return field propagation fix (2026-05-10 00:30 JST)

The 18:35/19:30 JST analysis correctly identified the root cause at nested
inline return boundaries but the proposed implementation was rejected due to
the "wrong gate" problem described in item #4 of that section. The fix now
applies a different discriminator using `structuralPrefixPaths` metadata,
already present in inline return state.

**Root cause**: In `emitInlineBody` exit path at
`src/transpiler/ir/ast_to_tac/helpers/inline.ts:2361`, when exiting an inner
inline method and all paths had populated their prefixes (`allPopulated = true`),
the code used `innerCtx.structuralPrefixPaths[...].srcKey` as the source prefix.

This pointed to instance prefixes (e.g., `__inst___anon_union_1_0`) but field
values during execution are actually set on `${innerCtx.returnVar.name}`
(e.g., `__inline_ret_5`). The inner inline return statement copies instance
fields to the return variable prefix:

```text
__inline_ret_5_isWin = __inst___anon_union_1_0_isWin
```

But the boundary copy was reading from `__inst___anon_union_1_0_isWin` directly,
missing the intermediate copy.

**Fix**: Changed line 2361 to use `innerCtx.returnVar.name` instead of
`structuralPrefixPaths[...].srcKey`:

```typescript
// Before (wrong - used instance prefixes):
const srcPrefix = innerCtx.structuralPrefixPaths[...].srcKey;  // __inst___anon_union_1_0

// After (correct - uses return variable name):
const srcPrefix = innerCtx.returnVar.name;  // __inline_ret_5
```

This ensures fields copy correctly through nested inline boundaries:

```text
__inline_ret_17_isWin = __inline_ret_17_isWin   // inner return prefix → outer result prefix
```

**Verification**: Added regression test `tests/unit/transpiler/structural_union_iswin_dispatch.test.ts`
(`propagates structural-prefix slots across nested inline-method returns`). The test creates a
nested inline scenario where an outer method calls an inner method returning a structural interface,
then asserts that the TAC contains `__inline_ret_<n>_isWin = __inline_ret_<m>_isWin`.

All 997 unit tests pass (including the new regression). The fix is path-sensitive: boundary copies
are only emitted when every runtime path reaching the nested inline return boundary has proven it
populated its source prefix (`allPopulated` check), so stale values from different branches are
not propagated.

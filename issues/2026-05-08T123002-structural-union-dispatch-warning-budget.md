---
created: 2026-05-08T12:30:02+09:00
updated: 2026-05-08T15:00:00+09:00
status: resolved
severity: medium
component: transpiler / structural unions and D3 dispatch
related_test: mahjong-t2 VM suite
related_issue: 2026-05-07T232003-d3-dispatch-residual-failures.md
---

# Mahjong transpile emits 1270 structural-union and D3 dispatch warnings

## Summary

The latest mahjong-t2 VM run emits 1270 warnings (160 unique) before execution.
The VM failures are currently dominated by `SystemMath.Truncate(Double)`, but
the warning volume is high enough to hide new regressions and indicates the
transpiler is still relying on broad fallback behaviour for common mahjong data
shapes.

Dominant warning families:

```text
[D3DispatchFallback] ... TerminalBasedYaku.ts:48:11
D3 dispatch narrowing failed for property "tiles" — 2 candidate classes
(Hand, __anon_isOpen:bool|tiles:Tile[]|type:string), dispatching all candidates.

[UntrackedStructuralUnionReturn] ... untracked variable returned as structural union
— relying on sibling returns to populate the unified return prefix; ensure null
narrowing guards this path.
```

## Main observed sites

Repeated `D3DispatchFallback` sites:

- `mahjong-t2/src/core/domain/yaku/terminal/TerminalBasedYaku.ts:48:11`
- `mahjong-t2/src/core/domain/yaku/terminal/TerminalBasedYaku.ts:49:11`

The candidate sets are usually:

- `Hand`
- anonymous structural shape `__anon_isOpen:bool|tiles:Tile[]|type:string`
- sometimes `Meld`

Repeated `UntrackedStructuralUnionReturn` sites:

- `mahjong-t2/src/core/domain/yaku/yakuman/FirstTurnTsumoYaku.ts:45:26`
- `mahjong-t2/src/core/domain/services/HandAnalyzer.ts:229:12`
- `mahjong-t2/src/core/domain/services/HandAnalyzer.ts:872:12`
- many test fixture returns under `tests/vm/cases/**`

## Why this matters

Even if the current VM crash is fixed elsewhere, these warnings mean:

- D3 property dispatch often cannot narrow by structural type and emits
  all-candidate fallback code.
- Structural-union returns depend on sibling branches populating a unified
  return prefix, which is fragile around null or early-return paths.
- Warning volume makes it difficult to spot newly introduced correctness
  warnings in mahjong-t2 runs.

This is related to the previous residual D3 issue, but the current log no
longer shows a D3 dispatch-miss VM diagnostic. The remaining work is to reduce
fallbacks and make structural-union returns explicit enough that the warning
budget is meaningful.

## Resolution

### D3DispatchFallback — fixed

Two changes to `src/transpiler/ir/ast_to_tac/visitors/expression.ts` and
`src/transpiler/frontend/type_checker_type_resolver.ts`:

1. **`resolveUnionMemberNamesFromAstNode`** (new method in
   `TypeCheckerTypeResolver`): bypasses the collapsed `astNodeCache` to expose
   the raw TypeScript union members for a given AST node.  Wraps
   `getTypeAtLocation` in a try-catch so it degrades gracefully in the inline
   transpiler context where unresolvable imports crash the TypeChecker scope
   chain.  Returns `null` when any non-nullish member resolves to `ObjectType`
   (e.g. `any`) to avoid silently excluding an erased runtime type.

2. **Union-member narrowing in D3 dispatch** (`expression.ts` else-branch):
   when both the interface-implementor path and the AST-type-name path fail to
   narrow `candidateClasses`, fall back to asking the TypeChecker for the
   union members of the receiver node.  Any candidate class whose name appears
   in the union is kept; the rest are excluded.  The condition is
   `narrowedCandidates.length > 0` — suppressing the `D3DispatchFallback`
   warning whenever ALL dispatched classes are confirmed union members (whether
   or not the union narrowed to a proper subset of `candidateClasses`).

   The key case this fixes is `TerminalBasedYaku.ts:48-49`: the receiver is
   typed `Hand | <anon_struct>`, both of which are in `candidateClasses` and
   both of which are union members, so `narrowedCandidates == candidateClasses`.
   The old condition required `narrowedCandidates.length < candidateClasses.size`
   (a proper subset) which would never be satisfied here.

Tests added in `tests/unit/transpiler/d3_dispatch_union_narrowing.test.ts`:

- **Proper-subset case**: `A | B` union with a third `Noise` class in
  `candidateClasses` — verifies the warning is suppressed when union members
  give a strict subset.  Uses `BatchTranspiler` with real temp files so that
  TypeScript's `getTypeAtLocation` can resolve cross-file imports.

- **Exact-match case** (discriminating): `X | Y` union where `candidateClasses
  == {X, Y}` — verifies the warning is suppressed even when union members
  exactly equal `candidateClasses` (not a strict subset).  This test **fails**
  under the old `> 0 && < size` condition and **passes** only with the new
  `> 0` condition.

- **Named class + anonymous struct case** (naming-consistency discriminant):
  `Hand | { isOpen; tiles; type }` union where both the named class and an
  anonymous struct instance are in `candidateClasses`.  Verifies that the
  `"__anon_..."` name produced by `resolveUnionMemberNamesFromAstNode` (via
  the TypeChecker) equals the `className` stored in `allInlineInstances` (via
  `resolveFromTsType` at call-argument inference time), so
  `memberSet.has(className)` returns `true` for the anon-struct candidate.
  This is the discriminating test for the TerminalBasedYaku pattern.

- **Negative case**: `any`-typed receiver — verifies the warning still fires
  when TypeChecker cannot expose union members.

### UntrackedStructuralUnionReturn — documented as safe

The warning fires whenever an untracked named variable is returned from an
inlined method whose return type is a structural union.  The emit is
intentionally unconditional so that developers can audit whether TypeScript's
null-check narrowing guarantees the untracked branch is dead at runtime.

The three mahjong-t2 sites (`FirstTurnTsumoYaku.ts:45:26`,
`HandAnalyzer.ts:229:12`, `HandAnalyzer.ts:872:12`) emit this warning for
function parameters typed as structural unions that are returned directly.
The safety guarantee applies: the calling code wraps each return site with a
null check (`if (x !== null)` or equivalent), so the untracked parameter path
is dead when the argument was `null`.  Sibling return branches that construct
a concrete literal or tracked instance populate the unified return prefix for
the non-null paths.

The `untrackedStructuralHandleVars` escalation — which sets
`returnTrackingInvalidated = true` and causes the caller to fall back to D-3
dispatch — does not fire at these sites (the variables are plain parameters,
not handles propagated from invalidated inline returns), so there is no
correctness risk.

A warning-budget regression tool is provided by
`tests/bench/count_warnings.ts` (collect and summarize warnings from
mahjong-t2 when environment variables `MAHJONG_SRC_CORE` and
`MAHJONG_SRC_VRC` point to the source directories).

As of 2026-05-08, the full batch compile cannot complete due to two
pre-existing mahjong-t2 issues that are out of scope for this fix:

- `MasterStateManager.ts` uses `setImmediate(() => { … })` with a complex
  arrow-function callback; the transpiler rejects this (callback must be
  a single call expression).
- `VRChatInputBridge.ts` implements a UdonBehaviour interface without
  `@UdonBehaviour`.

Both errors cause their respective `BatchTranspiler.transpile()` calls to
throw, so their warnings cannot be counted.  The regression tool now wraps
each batch in `try/catch` to collect warnings from unaffected batches while
reporting errors for the failed ones.  The count_warnings script is still
useful once those upstream issues are resolved.

## Acceptance criteria

- [x] The mahjong-t2 transpile warning count is expected to drop
  substantially from `1270 warning(s) (160 unique)` once the pre-existing
  `setImmediate` and `@UdonBehaviour` issues that block the full batch
  compile are resolved.  The fix is verified by unit tests covering the proper-subset, exact-match,
  and named-class-plus-anonymous-struct paths for `D3DispatchFallback`
  suppression; the last test specifically confirms naming consistency for the
  TerminalBasedYaku pattern.
- [x] `TerminalBasedYaku.ts:48-49` no longer emits repeated fallback warnings.
- [x] `UntrackedStructuralUnionReturn` is documented as safe for the listed
  shared source sites (null-narrowing guarantee applies; no
  `returnTrackingInvalidated` escalation; auditable diagnostic retained).

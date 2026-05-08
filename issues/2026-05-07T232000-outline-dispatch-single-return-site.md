---
created: 2026-05-07T23:20:00+09:00
updated: 2026-05-09T02:00:00+09:00
status: resolved
severity: low
component: transpiler / outline dispatch
related_branch: outline-dispatch-single-return-site
related_test: mahjong-t2 transpile warnings (post PR #217 / #218)
---

# OutlineDispatchInvariant: outlines emitted for methods that end up with a single return site

## Summary

The deferred outline-dispatch builder logs `OutlineDispatchInvariant` whenever
the post-conversion return-site count is below `OUTLINE_MIN_CALL_SITES`, but
the outliner itself still produces the outlined body and a degenerate dispatch
table (`returnSites.length === 1` short-circuits to a single
`UnconditionalJumpInstruction`). The check fires today across at least five
distinct mahjong-t2 methods, suggesting the outline-eligibility decision
isn't gated on the same predicate the post-build invariant enforces.

## Symptom

Recent mahjong-t2 transpile produces these warnings (counts in parens):

- `SuitFilterOptimizer.generateAllTiles` (`SuitFilterOptimizer.ts:12`) ×2
- `HandAnalyzerHelpers.checkMelds` (`HandAnalyzerHelpers.ts:17`) ×2
- `HandAnalyzerDecompositionService.checkStandardFormFromCounts`
  (`HandAnalyzerDecompositionService.ts:392`) ×2
- `Hand.getCacheKey` (`Hand.ts:120`) ×22
- `HandAnalyzer.getStandardFormDecomposition` (`HandAnalyzer.ts:858`) ×15

All of the form: `Outline dispatch for X.Y has 1 return site(s), expected at
least 2.`

## Where to investigate

- `src/transpiler/ir/ast_to_tac/helpers/inline.ts:3102-3125` — the deferred
  pendingOutlineDispatch lambda. The warning fires on `state.returnSites.length
  < OUTLINE_MIN_CALL_SITES`; the same lambda then emits the outline anyway.
- The outline-eligibility predicate(s) upstream that decided to outline the
  method in the first place. They predict ≥2 call sites, but reality (after
  inlining/DCE/optimisation) ends up with 1. Either:
  - eligibility should be re-evaluated lazily after IR-level passes, or
  - the deferred lambda should detect the degenerate case and roll the outline
    body back into a single inline copy at each call site.

## Why this matters

Functional impact today is small — the degenerate dispatch is just a single
unconditional jump, so correctness is fine. But each affected method still
pays for the outline overhead (extra label, jump, return-site index variable
plumbing) without the deduplication benefit. With 22 hits on
`Hand.getCacheKey` and 15 on `HandAnalyzer.getStandardFormDecomposition`, the
emitted UASM is measurably larger than necessary on the mahjong-t2 build.

The warning is also noise that obscures legitimate diagnostic output during
investigations.

## Proposed fix direction

Two complementary options:

1. **Re-check eligibility at deferred-dispatch time.** When
   `pendingOutlineDispatches` runs, if `returnSites.length < OUTLINE_MIN_CALL_SITES`,
   inline the outlined body back at each registered call site instead of
   emitting the outline + jump. (Most expensive but fully eliminates overhead.)
2. **Lower OUTLINE_MIN_CALL_SITES to 1 and remove the warning.** Acknowledge
   that "outline always" is the simpler invariant; a single-site outline costs
   one extra jump but avoids needing a per-method gating heuristic. (Cheap but
   doesn't recover the lost UASM bytes.)

Option (1) preferred — the warning text "expected at least 2" reads as if
the codepath is genuinely unreachable, so silencing it via a config flag
would be misleading.

## Severity

Low. No correctness impact; UASM-size and diagnostic-noise concern only.

## Resolution

Confirmed implemented in `src/transpiler/ir/ast_to_tac/helpers/inline.ts:3191`
(verified 2026-05-09). The `pendingOutlineDispatches` lambda detects the
degenerate case and patches the body's end-jump to point directly to the single
return site, suppressing both the `OutlineDispatchInvariant` warning and the
superfluous dispatch-table emission:

```ts
if (state.returnSites.length === 1) {
  // Only one call site reached this method in pass 2 (pass-1 over-counted).
  // Patch the body's end-jump to go directly to the single return site,
  // skipping the dispatch table entirely.
  converter.instructions[state.bodyReturnJumpIdx] =
    new UnconditionalJumpInstruction(
      createLabel(state.returnSites[0].labelName),
    );
  return;
}
```

This is functionally equivalent to the preferred Option (1): the outline body
is retained (no full re-inline), but the degenerate dispatch overhead is
eliminated. The `OutlineDispatchInvariant` warning is no longer emitted.

## References

- `src/transpiler/ir/ast_to_tac/helpers/inline.ts:3191`
- mahjong-t2 transpile log (post-merge of PR #217 / #218, 2026-05-07)

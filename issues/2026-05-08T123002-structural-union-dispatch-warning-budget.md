---
created: 2026-05-08T12:30:02+09:00
updated: 2026-05-08T12:30:02+09:00
status: open
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

## Investigation tasks

1. Reproduce the warning count from mahjong-t2 and capture warnings grouped by
   code and source location.
2. For `TerminalBasedYaku.ts:48-49`, inspect the receiver type flow and explain
   why `Hand`, `Meld`, and the anonymous `{ isOpen, tiles, type }` shape remain
   indistinguishable at the property access.
3. Improve structural narrowing so property dispatch can prefer the concrete
   receiver when the surrounding control flow or assignment source proves it.
4. For `UntrackedStructuralUnionReturn`, either:
   - track the returned variable's structural prefix explicitly; or
   - downgrade the warning only when all sibling return branches are proven to
     initialise the same unified prefix and null paths are guarded.
5. Add a warning-budget regression test or snapshot for a small reproducer so
   these warnings do not silently return.

## Acceptance criteria

- The mahjong-t2 transpile warning count drops substantially from
  `1270 warning(s) (160 unique)`.
- `TerminalBasedYaku.ts:48-49` no longer emits repeated fallback warnings for
  ordinary `Hand` / structural meld-like property access.
- `UntrackedStructuralUnionReturn` is either eliminated for the listed shared
  source sites or documented as safe with a narrower, lower-noise diagnostic.


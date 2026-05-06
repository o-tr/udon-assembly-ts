---
created: 2026-05-07T02:40:01+09:00
updated: 2026-05-07T02:40:01+09:00
status: open
severity: high
component: transpiler / D3 method dispatch
related_branch: feat/number-double-mapping
related_test: mahjong-t2 VM suite (~19 tests)
---

# D3 method dispatch miss returns null sentinel that cascades into op_Implicit_Double crash

## Summary

When the inline-handle D3 dispatch table cannot resolve a method call
("untracked instance"), the fallback emits a `LogError` and returns the
default-initialised dispatch result temp. Downstream code (e.g. wrapping the
result in a DataToken) then operates on a null/garbage Double and crashes
inside `DataToken.__op_Implicit__SystemDouble__VRCSDK3DataDataToken`.

## Symptom

mahjong-t2 VM tests, ~19 of the 26 remaining failures show:

```text
[Error] [udon-assembly-ts] D3 method dispatch miss: check on untracked instance
...
Inner: UdonVMException: An exception occurred during EXTERN to
  'VRCSDK3DataDataToken.__op_Implicit__SystemDouble__VRCSDK3DataDataToken'.
```

The `check` method is `BaseYaku.check(context: YakuCheckContext): YakuCheckResult` —
an abstract method that concrete Yaku subclasses override. When the dispatcher
fails to identify which subclass instance is being called against, control
falls through to the diagnostic LogError and the dispatch result keeps its
default sentinel value.

## Root cause path

1. `tryD3MethodDispatch` (call.ts:1180–1452) attempts handle-based dispatch
   against a list of candidate inline classes.
2. If no candidate matches, the fallback at call.ts:1430+ emits a
   `Debug.LogError` and falls through, leaving `dispatchResult` initialised
   only by `emitDispatchResultDefaults` (which writes a sentinel for the
   declared return type — `null` for an interface like `YakuCheckResult`).
3. Caller treats `dispatchResult` as a real `YakuCheckResult`, reading its
   `.score`/`.fu`/`.han` fields. Those fields hold the SoA prefix defaults
   (zeroed Double values for numeric fields after the number=Double remap).
4. A downstream `wrapDataToken(value)` on one of those Double prefix fields
   reaches `DataToken.op_Implicit(Double)` with a token slot whose underlying
   StrongBox is uninitialised — the EXTERN dispatcher throws.

## Where to investigate

- `src/transpiler/ir/ast_to_tac/visitors/call.ts:1180-1452` — D3 dispatch
- `src/transpiler/ir/ast_to_tac/visitors/call.ts:468-490` — `emitDispatchResultDefaults`
- `src/transpiler/ir/ast_to_tac/helpers/inline.ts` — inline class instance map
- `src/transpiler/ir/ast_to_tac/helpers/assignment.ts:wrapDataToken` —
  consider an early-bail when the operand slot is provably unwritten
  (`StrongBox<Object>` with null Reference, or sentinel-typed)

## Why this is independent of Phase A

The D3 dispatch miss exists on master too (recorded in CLAUDE.md memory:
"D-3 Dispatch (uninst_prop pattern): Handle-based dispatch for untracked
inline instances; limit ≤100 instances per class"). On master the sentinel
defaults are Single rather than Double, but the cascade pattern is the same
— the wrap path for the polluted result then hits the Single ctor crash
instead. The op_Implicit fix introduced on `feat/number-double-mapping`
just changed the surface signature.

## Affected tests (mahjong-t2 VM suite, ~19 failures)

`hand_win_detection`, `yaku_*`, `scoring_*`, `score_distribution`,
`hand_tenpai`, `wait_types`, `tenpai_edge`, `win_chiitoitsu` — all crash on
`__op_Implicit__SystemDouble__VRCSDK3DataDataToken` after the diagnostic
"D3 method dispatch miss: check on untracked instance".

## Proposed fix direction

Two complementary improvements:

1. **Track every Yaku subclass that implements `check` as an inline-instance
   candidate** so the D3 table never misses. Likely a metadata-collection
   gap in `ClassRegistry` / `udonBehaviourClasses`.
2. **Defensive sentinel** for the dispatch result so even a missed dispatch
   does not corrupt downstream wraps — e.g., short-circuit the caller when
   `dispatchResult` is identifiable as the diagnostic fallback (via a
   `dispatched` flag temp).

## Severity

Blocks 19/38 mahjong-t2 VM tests. Independent of Phase A — fixing in
isolation would benefit master as well.

## References

- mahjong-t2 fixtures: `tests/vm/cases/*.ts` in mahjong-t2
- CLAUDE.md memory: "D3 Dispatch (uninst_prop pattern)"
- Branch baseline: `feat/number-double-mapping` (and master pre-Phase-A)

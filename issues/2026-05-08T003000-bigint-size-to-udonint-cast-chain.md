---
created: 2026-05-08T00:30:00+09:00
updated: 2026-05-09T17:20:00+09:00
status: open
severity: low
component: transpiler / codegen
---

# Redundant Int32→Int64→Int32 cast chain for `BigInt(Map.Count) as UdonInt`

## Summary

When a caller converts `Map.Count` (or any Int32-typed property) to `UdonInt` via
`BigInt(this.cache.size) as UdonInt`, the transpiler emits two unnecessary convert externs:

```text
Int32  →  Int64   (BigInt() is always compiled as CastInstruction(Int64))
Int64  →  Int32   (narrowed back to UdonInt / Int32 at the comparison or return site)
```

The values are always within Int32 range, so the round-trip is semantically correct but
generates noise in the emitted Udon Assembly.

## Affected files

- `tests/vm/cases/lru_numeric_compare_regression.ts` — `isDifferentSize`, `isOverflow`
- `tests/vm/cases/lru_cache_map_get_regression.ts` — `set`, `size`
- `tests/vm/cases/mahjong_lru_cache_regression.ts` — `set`, `size`

All three use the pattern `BigInt(this.cache.size) as UdonInt` (or in comparisons
`BigInt(this.cache.size) > this.maxSize`).

## Root cause

The transpiler's handling of `BigInt(x)` always targets `PrimitiveTypes.int64`
(`CastInstruction(Int64)`), regardless of the destination type. When the result is
immediately used in an `UdonInt` (Int32) context, a second narrowing cast is emitted.

The test files cannot use `this.cache.size as unknown as UdonInt` as a shortcut because
they are dual-use: the same source runs both as transpiler input and as JavaScript via
the Vite test pipeline. At JS runtime `Map.size` is a `number`, and `UdonInt` must hold
an actual `bigint`, so the `BigInt()` call is required for runtime correctness.

## Potential fix

Teach the transpiler to emit a direct `Int32` cast (or no cast at all) when `BigInt(x)`
appears in a context where the destination type is already `Int32`/`UdonInt` and `x` is
statically known to be `Int32`. This would be a pure codegen optimisation with no
behavioural change.

Alternatively, a dedicated transpiler-recognised helper (e.g. `UdonTypeConverters.toUdonInt()`)
could be resurrected as a typed no-op that signals "this Int32 is already the right type"
without going through Int64.

## Impact

Minor assembly bloat only — two extra extern calls per affected site. No correctness risk.

## Audit update (2026-05-09 17:20 JST)

Latest local HEAD is `f7c9393` (`Merge pull request #238 from
o-tr/recursive-stack-datalist-token-restore`). No recent diff or merge in the
recursive-stack / mahjong VM fix series touches this optimisation. Keep this
issue open as a low-priority codegen cleanup; it is not a blocker for the
current mahjong-t2 VM correctness work.

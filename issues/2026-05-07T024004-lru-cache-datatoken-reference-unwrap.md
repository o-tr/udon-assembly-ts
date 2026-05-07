---
created: 2026-05-07T02:40:04+09:00
updated: 2026-05-07T02:40:04+09:00
status: open
severity: medium
component: transpiler / unwrapDataToken
related_branch: master / feat/number-double-mapping (both fail)
related_test: mahjong-t2 lru_cache
---

# `lru_cache` test crashes on `DataToken.__get_Reference__SystemObject` for value-typed token

## Summary

The `lru_cache` regression test crashes when an LRU value is read back via
`DataToken.Reference`, but the underlying token was stored as a value-typed
boxing (e.g., `TokenType.Int`/`TokenType.String`) rather than a reference.
`DataToken.Reference` getter throws on non-reference token types.

## Symptom

mahjong-t2 VM suite, `lru_cache` test:

```text
Inner: UdonVMException: An exception occurred during EXTERN to
  'VRCSDK3DataDataToken.__get_Reference__SystemObject'.
PC: 0x00000ECC
Captured logs: ["True","hello","2"]
Expected logs: ["True","hello","2","False","True","3","0"]
```

The first three logs succeed; the fourth read fails on `.Reference`.

## Root cause hypothesis

The `unwrapDataToken` helper's switch
(`src/transpiler/ir/ast_to_tac/helpers/assignment.ts:756-790`) picks
`property = "Reference"` for any target type that is `ObjectType` /
`GenericTypeParameterSymbol` / unrecognised. For a Map-like cache where the
declared value type is `unknown` / `any` / generic `T`, the unwrap defaults
to `.Reference` — which only works if the token was stored as an Object via
`DataToken.__ctor__SystemObject__VRCSDK3DataDataToken`.

When the cache stored a primitive (boxed via `op_Implicit` from String /
Int32 / Double), `.Reference` is invalid.

## Where to investigate

- `src/transpiler/ir/ast_to_tac/helpers/assignment.ts` — `unwrapDataToken`
  switch at `targetType.udonType` default case.
- Consider: when target is genuinely erased (`unknown`/generic), use
  `DataToken.IsNumber` / `DataToken.TokenType` to dispatch, then read via
  the matching getter. Or use `.ToString()` which always works.
- Alternative: track the cached token's actual `TokenType` in the inline
  registry so the unwrap site has the concrete getter target.

## Independent of Phase A

This was already failing on master (failure existed pre-`feat/number-double-mapping`)
and is the only mahjong-t2 VM failure that is NOT downstream of D3 dispatch
miss (issue 2026-05-07T024001).

## References

- mahjong-t2 fixture: `lru_cache` (LRU map test)
- Branch baseline: master and `feat/number-double-mapping` both fail this test

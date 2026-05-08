---
created: 2026-05-08T12:30:01+09:00
updated: 2026-05-08T13:28:00+09:00
status: fixed
severity: high
component: transpiler / DataToken unwrap
related_test: mahjong-t2 lru_cache
related_issue: 2026-05-07T024004-lru-cache-datatoken-reference-unwrap.md
---

# `lru_cache` regressed: `DataToken.Reference` getter is emitted again

## Summary

The mahjong-t2 `lru_cache` VM test is failing again on:

```text
Inner: UdonVMException: An exception occurred during EXTERN to
  'VRCSDK3DataDataToken.__get_Reference__SystemObject'.
PC: 0x00000E9C
Captured logs: ["True","hello","2"]
Expected logs: ["True","hello","2","False","True","3","0"]
```

This is the same class of failure as
`2026-05-07T024004-lru-cache-datatoken-reference-unwrap.md`, but that issue is
marked resolved and explicitly says generated UASM should contain no
`__get_Reference__SystemObject` for the LRU regression tests. The latest VM log
therefore indicates either a regression or a second unwrap path not covered by
the previous fix.

## Why this needs a new task

The previous issue's resolution cites two fixes:

- keep erased `unknown` / `any` / `object` DataToken values as `DataToken`
  rather than reading `.Reference`;
- preserve DataToken information across inline return slots.

The current failure reaches the fourth expected log, meaning primitive values
are still partly read correctly before a later path unwraps a token via
`.Reference`. This may be a different access pattern than the original
`map.keys().next().value` or inline return case.

## UASM deep dive

The generated `tests/vm/unity-project/TestInput/LRUCacheTest.uasm` confirms
the crash is on the eviction path for `LRUCache.set`, not on `get("a")`.

The VM log reports `PC: 0x00000E9C` (`3740` decimal). PC-to-line mapping shows:

```text
3668     PUSH, __inst_LRUCache_0_cache
3676     PUSH, __t93
3684     EXTERN, DataDictionary.__GetKeys__DataList
3692     PUSH, __t93
3700     PUSH, __const_40_SystemInt32
3708     PUSH, __t94
3716     EXTERN, DataList.__get_Item__SystemInt32__DataToken
3724     PUSH, __t94
3732     PUSH, __t95
3740     EXTERN, DataToken.__get_Reference__SystemObject
3748     PUSH, __t95
3756     PUSH, firstKey
3764     COPY
```

The same unsafe sequence appears multiple times in the file for the inlined
`LRUCache.set` body. The data section also contains a safe string getter:

```text
__extern_14: "VRCSDK3DataDataToken.__get_Reference__SystemObject"
__extern_18: "VRCSDK3DataDataToken.__get_String__SystemString"
```

The source is `mahjong-t2/src/core/domain/utils/LRUCache.ts`:

```ts
const firstKey = this.cache.keys().next().value;
if (firstKey !== undefined) {
  this.cache.delete(firstKey);
}
```

For `Map<string, unknown>`, `keys()` has element type `string`. In Udon,
`DataDictionary.GetKeys().Item(0)` returns a `DataToken` whose token type is
String, so unwrapping it through `.Reference` is invalid. The correct unwrap
for this path is `DataToken.String` (`__get_String__SystemString`) before
copying to `firstKey: %SystemString`.

The previous fix handles some iterator `.value` and erased DataToken cases, but
this generated UASM suggests the `keys().next().value` type hint is not
surviving in the `DataDictionary.GetKeys()` lowering path used by inlined
`Map.keys()`, or the resolved key element type is still being treated as erased
at the property access.

## Investigation tasks

1. Inspect generated UASM for mahjong-t2 `lru_cache` and locate the
   `VRCSDK3DataDataToken.__get_Reference__SystemObject` call at `PC: 0x00000E9C`.
2. Trace the source expression and target type at that unwrap site.
3. Verify whether `dataTokenValueHints`, iterator value type recovery, or inline
   return slot promotion is missing for this `Map<string, unknown>.keys()` path.
   The generated code should unwrap the key token as `String`, not `Reference`.
4. Add or update an in-repo regression test that asserts the generated UASM for
   the LRU cache path does not contain
   `__get_Reference__SystemObject` when the token may contain primitives.
5. Re-run `VM: lru_cache` after the fix.

## Root cause

The bug only manifested in **batch (cross-module) transpilation**. When LRUCache
was defined in a separate file, `TypeCheckerTypeResolver.tryResolveBuiltinGenericInterface`
returned bare `ExternTypes.dataDictionary` (no key/value type args) for `Map<K,V>`,
because it lacked the type-arg context. The `mapTypeWithGenerics` TypeChecker-first
path then returned that bare symbol early, bypassing the text-based `Map` case
that creates `CollectionTypeSymbol(dataDictionary.name, undefined, keyType, valueType)`.
The missing `keyType` caused the `keys().next().value` DataToken getter to fall
back to `__get_Reference__SystemObject` instead of `__get_String__SystemString`.

In single-file mode (inline transpiler), `checkerTypeResolver` is not set, so
the TypeChecker-first path was never taken and the text-based path always worked.

## Fix

`tryResolveBuiltinGenericInterface` now accepts the `ts.Type` and calls
`checker.getTypeArguments()` to extract key/value type args for `Map`/`ReadonlyMap`
and element type for `Set`/`ReadonlySet`, returning a proper `CollectionTypeSymbol`.
This mirrors the single-file parser-time path and propagates the type information
needed for correct DataToken getter selection.

Files changed:
- `src/transpiler/frontend/type_checker_type_resolver.ts`
- `tests/unit/transpiler/type_checker_type_resolver.test.ts` (updated 2 assertions)
- `tests/unit/transpiler/cross_module_lru_cache_eviction.test.ts` (new regression test)

## Acceptance criteria

- `VM: lru_cache` produces
  `["True","hello","2","False","True","3","0"]`.
- The generated UASM for the relevant LRU fixtures contains no unsafe
  `VRCSDK3DataDataToken.__get_Reference__SystemObject` unwrap for primitive-capable
  tokens.
- The previously resolved regression cases remain covered.

## Latest verification (2026-05-09)

The latest mahjong-t2 VM run confirms `VM: lru_cache` passes. The previous
`DataToken.__get_Reference__SystemObject` crash is no longer present in the
failed-test list.

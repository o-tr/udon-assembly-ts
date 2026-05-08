---
created: 2026-05-07T18:30:00+09:00
updated: 2026-05-08T00:00:00+09:00
status: resolved
severity: low
component: stubs / types
related_branch: branded-bigint-subtypes
---

# Introduce branded bigint subtypes (UdonInt, UdonUInt, UdonLong, UdonULong)

## Summary

The [stub-bigint-migration](./2026-05-07T024002-stub-bigint-migration-for-int-parameters.md) issue migrated bare `number` → `bigint` for integer-typed APIs. While this eliminates unnecessary Double→Int32 conversions at the EXTERN boundary, it loses compile-time type safety: callers cannot distinguish `UdonInt` from `UdonLong` at the TypeScript level.

The cleaner end state is branded subtypes of `bigint` that encode the C# type in the TypeScript type system:
- `UdonInt extends bigint` — maps to Int32 (32-bit signed)
- `UdonUInt extends bigint` — maps to UInt32 (32-bit unsigned)
- `UdonLong extends bigint` — maps to Int64 (64-bit signed, current bigint default)
- `UdonULong extends bigint` — maps to UInt64 (64-bit unsigned)

## Scope

This is a separate, larger refactor that should be tracked independently from the bare-`number` → `bigint` migration. The branded types would:
1. Provide compile-time distinction between integer sizes at the stub level
2. Allow the transpiler to emit correct type annotations per C# signature
3. Enable stricter type checking for cross-language calls

## Dependencies

- Requires completion of stub bigint migration ([stub-bigint-migration](./2026-05-07T024002-stub-bigint-migration-for-int-parameters.md))
- May coordinate with TypeID emitter alignment (`GetUdonTypeID()` return type)
- Would need transpiler changes to recognize branded types and emit correct TAC instructions

## Resolution

Implemented in branch `branded-bigint-subtypes` (commit `1d6af7a`).

### Changes

- **`src/stubs/UdonTypes.ts`**: `UdonInt = bigint & { readonly __brand: "UdonInt" }`, `UdonUInt` similarly. Existing `UdonLong`/`UdonULong` already used bigint; branded variants added.
- **`src/stubs/`**: All stub APIs updated to accept/return `UdonInt` / `UdonUInt` instead of plain `number` for Int32/UInt32 parameters (SystemTypes, UnityTypes, DataContainerTypes, UdonCollections, VRChatTypes).
- **`src/transpiler/`**: Type symbol and type resolver updated to recognise the branded bigint types and emit correct TAC cast instructions (`CastInstruction(Int32)` for `UdonInt`, etc.).
- **`tests/vm/runtime-stubs/`**: Runtime stub implementations updated — `BigInt(Math.floor(...)) as UdonInt`, `Number(udonInt)` for arithmetic, DataList/DataDictionary index signatures extended with `| bigint`.
- **`tests/vm/cases/` and `tests/uasm/sample/`**: ~70 test files migrated to bigint literal syntax (`15n as UdonInt`), `Number(x)` for UdonInt→number conversions, `get_Item()` for array access with UdonInt indices, `BigInt(n) as UdonInt` for number→UdonInt in loop variables.

### Outcome

- `pnpm typecheck`: 0 errors (was ~164 errors across 33 files)
- `pnpm test`: 943 passed, 0 failed (94 test files)

### Notes

- `UdonLong` / `UdonULong` branded variants were added to stubs but test coverage focuses on `UdonInt` / `UdonUInt` as those are the predominant Int32/UInt32 call sites.
- The Vite cast plugin (`tests/vm/vite-udon-cast-plugin.ts`) handles `expr as UdonInt` → `__castToInt(expr)` (number truncation) and `expr as UdonFloat` → `__castToFloat(expr)`. The `as unknown as UdonInt` double-cast pattern is used where truncation is required by TypeScript's bigint↔number restrictions.

## References

- Migration issue: [stub-bigint-migration](./2026-05-07T024002-stub-bigint-migration-for-int-parameters.md)
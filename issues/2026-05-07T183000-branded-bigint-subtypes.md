---
created: 2026-05-07T18:30:00+09:00
updated: 2026-05-07T18:45:00+09:00
status: open
severity: low
component: stubs / types
related_branch: stub-bigint-migration-for-int-parameters
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

## References

- Migration issue: [stub-bigint-migration](./2026-05-07T024002-stub-bigint-migration-for-int-parameters.md)
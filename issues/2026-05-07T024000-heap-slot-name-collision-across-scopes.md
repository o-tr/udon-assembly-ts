---
created: 2026-05-07T02:40:00+09:00
updated: 2026-05-07T03:10:00+09:00
status: resolved
resolution: cd7eb5a fix(ir) skip tracking COPY when unwrapDataToken is a no-op
severity: high
component: transpiler / TAC array access
related_branch: feat/number-double-mapping
related_test: tests/vm/cases/mahjong_tile_sort_compare_regression.ts
---

# `mahjong_tile_sort_compare_regression` crash via `HeapTypeMismatchException`

## Summary

`Tile.sortTiles` / `sortThreeTiles` crash on
`SystemInt32.__op_GreaterThanOrEqual__SystemInt32_SystemInt32__SystemBoolean`
because a downstream Int32 heap slot's `StrongBox<Int32>` is rewritten to
`StrongBox<DataToken>` by an unwrap-then-tracking-COPY that fires when
`unwrapDataToken` returns its input unchanged.

## Initial (incorrect) hypothesis

Originally suspected a scope-name collision: `Tile.fromCode` declares
`const c = code as number` (Int32) and `Tile.sortThreeTiles` declares
`let c = tiles[2]` (Tile/Object). Both compile to the same heap variable
`c: %SystemInt32`. This IS a latent transpiler issue, but it was NOT the
trigger of this crash — `sortThreeTiles`'s `t → c` COPY happens long after
the failing instruction.

## Actual root cause

PC 0x0003A048 maps to the bounds check **inside `sortTiles`'s inner
loop**, not `fromCode`:

```
soa_list_ready1786:
  PUSH __soa_Tile_kind
  PUSH __t4277             # length
  EXTERN get_Count
  PUSH a                   # ← a is %SystemInt32
  PUSH __const_3_SystemInt32  # 0
  PUSH __t4278
  EXTERN op_GreaterThanOrEqual_Int32_Int32  ← throws HeapTypeMismatchException
```

A few hundred lines earlier, `current = result[i]` lowers via
`visitArrayAccessExpression`'s DataList fast-path:

```ts
const unwrapped = this.unwrapDataToken(tokenResult, elementType);
const resultType = resolveInlineClassType(this, elementType);
const result = this.newTemp(resultType);
this.emitCopyWithTracking(result, unwrapped);  // ← the bug
return result;
```

`elementType` is `ObjectType` (spread `[...tiles]` erased the `Tile`
element type). `unwrapDataToken` short-circuits for Object targets and
returns `tokenResult` unchanged — but the unconditional
`emitCopyWithTracking` then COPYs that DataToken into a fresh
`%SystemObject` slot.

`UdonHeap.CopyHeapVariable` (verified IL_0219-IL_0262 in
`VRC.Udon.Common.dll`):

```il
// dest StrongBox is NOT IsInstanceOfType(sourceType)
//   → create new StrongBox of source.GetType()
//   → overwrite heap[destAddr] with new StrongBox
```

The dest slot's `StrongBox<Object>` is replaced by `StrongBox<DataToken>`.
That DataToken-shaped slot is later assigned (via inline `Tile.compare`
expansion) into local `a: %SystemInt32`, propagating the wrong StrongBox
type. The next `op_GreaterThanOrEqual<Int32>` reads the slot via
`UdonHeap.GetHeapVariableInternal<int32>` (IL_002a-IL_00a0 of the same
DLL) and throws `HeapTypeMismatchException`.

## Why master passes

Master emits the same source pattern but, before the
`feat/number-double-mapping` branch added the unconditional tracking COPY,
the array-access fast path returned the DataToken directly when unwrap was
a no-op. Master never produces the broken `DataToken → %SystemObject` COPY.

The user's earlier WIP (added before this session, expression.ts +48 lines)
introduced the unconditional COPY; the bug was latent until Phase A's
heap-slot reordering exposed an execution path that hit it.

## Fix (commit `cd7eb5a`)

Identity-check the unwrap result and skip the tracking COPY when it was
a no-op:

```ts
const unwrapped = this.unwrapDataToken(tokenResult, elementType);
if (unwrapped === tokenResult) return tokenResult;  // ← new
const resultType = resolveInlineClassType(this, elementType);
const result = this.newTemp(resultType);
this.emitCopyWithTracking(result, unwrapped);
return result;
```

Applied at both DataListTypeSymbol fast-path and the trailing
ArrayTypeSymbol lowering in `visitArrayAccessExpression`.

## Verification

- VM: 363/363 pass (matches master baseline — restored from 362/363)
- Unit: 861/1044 pass (no change)
- typecheck: clean

## Latent issue still tracked separately

The original scope-name collision concern (same heap-variable name reused
across functions with different types) is a real but separate transpiler
limitation. Not retriggered by any current test on master, but worth
proper scope-aware slot mangling in a follow-up — file a fresh issue if
it ever resurfaces.

## References

- Fix commit: `cd7eb5a fix(ir): skip tracking COPY when unwrapDataToken is a no-op`
- VM DLL traces: `VRC.Udon.Common.UdonHeap` — `CopyHeapVariable` /
  `GetHeapVariableInternal` (verified via `monodis`)

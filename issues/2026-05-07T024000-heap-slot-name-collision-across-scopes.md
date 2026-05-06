---
created: 2026-05-07T02:40:00+09:00
updated: 2026-05-07T02:40:00+09:00
status: open
severity: high
component: transpiler / TAC variable allocation
related_branch: feat/number-double-mapping
related_test: tests/vm/cases/mahjong_tile_sort_compare_regression.ts
---

# Heap slot name collision across scopes corrupts heap variable type

## Summary

Same local variable name in different functions shares a single Udon heap slot.
When the two scopes use incompatible types, `CopyHeapVariable` rewrites the
slot's `StrongBox<T>` to the source type, causing subsequent reads in the
original type to throw `HeapTypeMismatchException`.

## Reproducer

`tests/vm/cases/mahjong_tile_sort_compare_regression.ts`:

```ts
class Tile {
  static fromCode(code: UdonInt): Tile {
    const c = code as number;        // ← c is Int32
    if (c < 0 || c > 36) throw ...
    return Tile._getInstances()[c];
  }

  static sortThreeTiles(tiles: Tile[]): Tile[] {
    let a = tiles[0];
    let b = tiles[1];
    let c = tiles[2];                // ← c is Tile (Object)
    let t: Tile;
    if (Tile.compare(a, b) > 0) { t = a; a = b; b = t; }
    ...
  }
}
```

Both `c` references compile to the same heap variable `c: %SystemInt32`
in the emitted UASM. When inlined `sortThreeTiles` writes a `Tile` (Object)
value into that slot, the runtime `StrongBox<Int32>` is replaced by
`StrongBox<Tile>`. The next inlined `fromCode` bounds check
(`c >= 0` via `SystemInt32.__op_GreaterThanOrEqual__...`) calls
`heap.GetHeapVariable<int32>` and throws.

## VM dispatch trace (verified via monodis on `VRC.Udon.VM.dll` /
`VRC.Udon.Common.dll`)

`UdonHeap.CopyHeapVariable` fallback (IL_0219-IL_0262 in `VRC.Udon.Common.dll`):

```il
// dest StrongBox is NOT IsInstanceOfType(sourceType)
//   → create new StrongBox of source.GetType()
//   → overwrite heap[destAddr] with new StrongBox
```

`UdonHeap.GetHeapVariableInternal<T>` (IL_002a-IL_00a0 in same DLL) throws
`HeapTypeMismatchException("Cannot retrieve heap variable of type '{X}'
 as type '{Y}'")` when the slot's StrongBox type does not match T.

## Why master passes (and `feat/number-double-mapping` does not)

Master and branch both emit the exact same `c: %SystemInt32` declaration
and the exact same `PUSH t / PUSH c / COPY` sequence in `sortThreeTiles`.
The trigger differs only because Phase A reduces the heap-slot count
(fewer Single↔Double Convert temps), shifting the order of inline expansions
just enough that the first `Tile.fromCode` bounds check is reached **after**
the polluting COPY in the new emit order. Master happens to complete all
fromCode invocations before reaching the polluting COPY.

## Severity

Latent transpiler bug. Phase A (number=Double remap) made it observable, but
the underlying scope-name collision exists on master too — any future codegen
reordering or future user code with a Tile-shaped local named like an
Int32-typed local in another method can trigger the same crash.

## Proposed fix

Scope-aware heap slot mangling:

- Either rename collisions: emit `c__fromCode` / `c__sortThreeTiles` so each
  function-scope local gets a distinct slot.
- Or detect type-incompatible name reuse and allocate a separate slot per
  declaring scope.

Affects: TAC generation / variable naming pass. Likely
`src/transpiler/ir/ast_to_tac/` (variable-declaration visitor or symbol-table
slot resolver).

## Impact

Resolves the only remaining VM regression introduced by the
`feat/number-double-mapping` branch (1/363 failing).

## References

- Branch with reproducer: `feat/number-double-mapping`
- Failing test: `mahjong_tile_sort_compare_regression`
- VM DLL traces: `VRC.Udon.Common.UdonHeap` (CopyHeapVariable / GetHeapVariableInternal)

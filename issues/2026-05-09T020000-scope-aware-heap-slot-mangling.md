---
created: 2026-05-09T02:00:00+09:00
updated: 2026-05-09T02:40:00+09:00
status: open
severity: medium
component: transpiler / IR / inline expansion
related_issue: 2026-05-07T024000-heap-slot-name-collision-across-scopes.md
---

# Scope-aware heap slot mangling needed for same-named locals with different types

## Summary

When two different methods each declare a local variable with the same name but
different types, both are lowered to the same named heap slot. If both methods
are inlined into the same caller context, the slot's declared type is taken from
whichever method is encountered first. A later inline expansion writing a value
of a different type can corrupt the slot's `StrongBox` representation and cause
downstream `HeapTypeMismatchException` at runtime.

## Origin

Documented as a latent limitation in
`2026-05-07T024000-heap-slot-name-collision-across-scopes.md`:

> The original scope-name collision concern (same heap-variable name reused
> across functions with different types) is a real but separate transpiler
> limitation. Not retriggered by any current test on master, but worth
> proper scope-aware slot mangling in a follow-up — file a fresh issue if
> it ever resurfaces.

The concrete example from that investigation:

- `Tile.fromCode` declares `const c = code as number` → type `Int32`
- `Tile.sortThreeTiles` declares `let c = tiles[2]` → type `Tile` / `Object`

Both compile to the same heap slot `c`. If both methods are inlined into the
same call site, the second write can change the `StrongBox<Int32>` to
`StrongBox<DataToken>`, breaking the first method's later reads.

## Current state

Parameter-level name shadowing is already handled (`valueBackup` in
`InlineParamSaveEntry`, `inline.ts:102-106`): when an inlined parameter name
collides with a caller-scope variable, the caller's value is snapshotted into a
temp and restored after the inline body. This preserves the caller's value but
does NOT change the slot type — a type-incompatible write still corrupts the
`StrongBox`.

Local variables (non-parameter declarations inside inlined methods) receive no
such protection. The heap slot is allocated on first use and reused for every
subsequent inline expansion that happens to declare the same local name.

## Failure mode

Not currently reproduced by any test on master (the investigation in
`2026-05-07T024000` identified the collision but traced the actual crash to a
different root cause). However, the condition — two inlined methods sharing a
local name with incompatible types — is plausible in any large TypeScript
codebase using common short variable names (`i`, `c`, `n`, `k`, `tmp`, etc.).
The corruption is silent until a typed heap operation reads the wrongly-typed
`StrongBox`.

## Proposed fix direction

### Option A — Scope-qualified slot names

Prefix each inlined local's heap slot with a method-unique string (e.g.,
`__inline_<ClassName>_<methodName>_c` instead of bare `c`). This eliminates
sharing entirely. The downside is larger UASM data sections when the same
method is inlined many times.

### Option B — Type-check at assignment time

In `emitCopyWithTracking` (and raw `CopyInstruction` emission paths), detect
when the destination slot's declared type differs from the source value's type
in a way that would change `StrongBox` representation. Insert a cast or re-
declare the slot with the correct type before the COPY. This is similar to the
existing numeric coercion in `assignment.ts`.

### Option C — Inline-depth counter suffix

Append the current inline-nesting depth to all locally declared names during
expansion. Callers at depth 0 see unmangled names; each nested inline sees
`name__d1`, `name__d2`, etc. Cheaper than full scope qualification but still
prevents cross-method aliasing.

Option A is the safest and most general. Option C only prevents collisions
between inlines at *different nesting depths* — two sibling expansions at the
same depth (e.g. `Tile.fromCode` and `Tile.sortThreeTiles` both inlined at
depth 1) would both receive the same `__d1` suffix and still collide.
Option C does not fix the stated problem.

## Investigation tasks

1. Reproduce the collision: write a unit test where two methods each declare
   `let c: number` and `let c: Tile[]` (or any two distinct Udon types) and
   verify the generated TAC allocates two distinct heap slots.
2. Confirm the current slot-allocation path in
   `src/transpiler/ir/ast_to_tac/helpers/inline.ts` (`saveAndBindInlineParams`
   / local-variable declaration site) to locate where mangling should be
   inserted.
3. Implement and test the chosen option (recommend A; Option C does not prevent
   sibling-inline collisions and would not fix the `Tile.fromCode`/`Tile.sortThreeTiles`
   case described above).
4. Verify that the mahjong-t2 `Tile.fromCode` / `Tile.sortThreeTiles` inline
   pattern no longer shares the `c` slot.

## Acceptance criteria

- Two methods with a same-named local of different Udon types, when inlined into
  the same caller, generate distinct heap slots.
- No existing test regresses.
- `pnpm typecheck` and `pnpm test` pass clean.

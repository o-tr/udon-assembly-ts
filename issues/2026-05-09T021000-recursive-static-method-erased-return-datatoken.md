---
created: 2026-05-09T02:10:00+09:00
updated: 2026-05-09T03:30:00+09:00
status: resolved
severity: medium
component: transpiler / IR / recursive inline
---

## Resolution (2026-05-09)

Three coordinated changes wire DataToken promotion through both recursive
inline emitters and the recursive return path in `visitReturnStatement`.

1. `emitInlineRecursiveStaticMethod` (`inline.ts:2522`) and
   `emitInlineRecursiveInstanceMethod` (`inline.ts:3814`) now propagate
   `isErasedReturn` into the `inlineReturnStack.push` entry so
   `visitReturnStatement` can see the erased-return flag inside the body.
2. `visitReturnStatement` (`statement.ts:1554`) — the recursive return
   path (top inlineContext belongs to the current recursive method) now
   wraps the return value via `wrapDataToken` when
   `inlineContext.isErasedReturn` is true, mirroring the non-recursive
   wrap at line ~1747. Without this, the early `return` in the recursive
   branch directly copied a raw primitive into a DataToken-typed slot.
3. The TODO + `InlineErasedReturnType` warning at the static call site
   (`inline.ts:2063-2070`) is removed; the warning code is dropped from
   `TranspileWarningCode`. The instance call site never had the warning,
   and now needs none either — both paths handle erased returns correctly.

`wrapDataToken` short-circuits on a DataToken-typed input
(`assignment.ts:694-696`), so `return this.find(n - 1)` inside the body —
where the self-call result is already typed `DataToken` — is a no-op
re-wrap and does not produce a `DataToken(DataToken(x))`.

The overflow handler still skips sentinel initialization for the
DataToken-typed retVal (`inline.ts:2465`); on overflow the retVal slot
is uninitialized and the caller's `as T` will throw, which is the
documented behavior — overflow has already emitted `Debug.LogError`.

Regression tests cover both the static and instance recursive paths in
`tests/unit/transpiler/inline_erased_return.test.ts`.


# Recursive static inline methods with erased return type skip DataToken promotion

## Summary

For non-recursive inline static methods, `resolveInlineReturnType`
(`inline.ts:1040`) promotes `unknown`/`any`/`object` return types to
`DataToken` so the caller's `as T` unwrap path can see the concrete runtime
type (`inline.ts:1052`). This promotion path is explicitly skipped for
self-recursive methods, and a TODO comment marks the gap:

```ts
// inline.ts:2063
// TODO: erased return types on recursive paths need separate analysis;
// DataToken promotion is not applied here.
if (isPlainObjectType(returnType)) {
  this.warnAt(undefined, "InlineErasedReturnType",
    `inline recursive static method ${resolved.declaringClassName}.${methodName}
     has erased return type — DataToken promotion not applied;
     caller \`as T\` may fail at runtime.`);
}
return emitInlineRecursiveStaticMethod(this, methodName, method, returnType, ...);
```

The `InlineErasedReturnType` diagnostic is emitted but `isErasedReturn` is never
propagated back to the outer call site. The internal return slot is correctly
promoted to DataToken inside `emitInlineRecursiveStaticMethod` (via
`resolveInlineReturnType` at `inline.ts:2269`), but the outer caller context
never learns the slot holds a DataToken and may therefore apply a direct copy or
wrong unwrap instead of the DataToken-specific `as T` path.

## Why the promotion is non-trivial for recursive methods

`emitInlineRecursiveStaticMethod` (`inline.ts:2249`) does call
`resolveInlineReturnType` internally (`inline.ts:2269`) and uses
`effectiveReturnType` for `selfCallResult_N` locals and stack DataList items.
However, non-recursive inline uses `isErasedReturn` in the outer
`visitInlineStaticMethodCallImpl` to wire up the final result slot differently
(call site unwrap vs. direct copy). The recursive emitter has its own return
site layout (stack-based retVal slot, `inline_rec_done` label) and does not
propagate `isErasedReturn` back to the outer call site wiring, leaving the
caller's unwrap path potentially unmatched.

## Failure mode

If a recursive static method declares return type `unknown` or `object` and the
caller does `const result = method(...) as ConcreteType`, the generated UASM
may treat the return slot as `SystemObject` and attempt to use
`DataToken.__get_Reference__SystemObject` to unwrap it, which throws on
non-reference-typed tokens.

The transpiler currently warns via `InlineErasedReturnType` when this pattern is
encountered, so the failure is detectable at transpile time but not blocked.

## Scope

- `emitInlineRecursiveStaticMethod` (`inline.ts:2249`) — static self-recursion.
  The call site at `inline.ts:2062-2071` guards entry with
  `isPlainObjectType(returnType)` and emits `InlineErasedReturnType` before
  routing to the recursive emitter.
- `emitInlineRecursiveInstanceMethod` (`inline.ts:3534`) — instance self-recursion.
  The call site at `inline.ts:3909-3921` routes to `emitInlineRecursiveInstanceMethod`
  when `selfCallCountHint > 0` **without any `isPlainObjectType` guard or
  `InlineErasedReturnType` warning**. If an instance method has an erased return
  type and is self-recursive, the gap is silent — no diagnostic is emitted and
  the return slot is not promoted to DataToken.

## Investigation tasks

1. Construct a minimal reproducer: a recursive static method returning `unknown`
   whose base case returns a `string`, and a caller that does `as string` on
   the result.
2. Confirm whether `emitInlineRecursiveStaticMethod` correctly sets
   `effectiveReturnType` for the retVal stack slot and whether the call site
   uses the correct DataToken getter after the recursive call returns.
3. Determine whether the gap is in the retVal slot type, the call-site unwrap
   wiring, or both.
4. Apply the same promotion logic used in the non-recursive path, or document
   a clear invariant explaining why it is safe to omit it for self-recursive
   methods.
5. Add a regression test asserting correct unwrap for a recursive-static erased
   return.

## Acceptance criteria

- Recursive static methods with `unknown`/`any`/`object` return types either:
  - correctly promote the return slot to DataToken and wire the caller unwrap, or
  - have a documented invariant explaining why the caller `as T` is safe without
    promotion (e.g. the caller never reaches the erased case at runtime).
- The `InlineErasedReturnType` warning is either eliminated for safe cases or
  upgraded to a hard error for cases that cannot be made safe.
- `pnpm test` passes with the new regression case.

## References

- `src/transpiler/ir/ast_to_tac/helpers/inline.ts:2063-2070` — TODO and `InlineErasedReturnType` warning (static path)
- `src/transpiler/ir/ast_to_tac/helpers/inline.ts:1031-1055` — `resolveInlineReturnType` (non-recursive path)
- `src/transpiler/ir/ast_to_tac/helpers/inline.ts:2249` — `emitInlineRecursiveStaticMethod`
- `src/transpiler/ir/ast_to_tac/helpers/inline.ts:3909-3921` — instance recursive call site (no erased-return guard)
- `src/transpiler/ir/ast_to_tac/helpers/inline.ts:3534` — `emitInlineRecursiveInstanceMethod`

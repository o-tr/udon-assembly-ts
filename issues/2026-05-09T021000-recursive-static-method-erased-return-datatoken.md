---
created: 2026-05-09T02:10:00+09:00
updated: 2026-05-09T02:10:00+09:00
status: open
severity: medium
component: transpiler / IR / recursive inline
---

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

The `InlineErasedReturnType` diagnostic is emitted but the method proceeds with
the original (unerased) `returnType`, so the return-value slot and any caller
`as T` casts may operate on a type-mismatched heap slot.

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

- `emitInlineRecursiveStaticMethod` (`inline.ts:2249`) — static self-recursion
- `emitInlineRecursiveInstanceMethod` (`inline.ts:3534`) — contains the same
  comment in its docstring (`inline.ts:3514-3533`); the same restriction may
  apply if an instance method with an erased return type is self-recursive.

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

- `src/transpiler/ir/ast_to_tac/helpers/inline.ts:2063-2070` — TODO and warning
- `src/transpiler/ir/ast_to_tac/helpers/inline.ts:1031-1055` — `resolveInlineReturnType` (non-recursive path)
- `src/transpiler/ir/ast_to_tac/helpers/inline.ts:2249` — `emitInlineRecursiveStaticMethod`
- `src/transpiler/ir/ast_to_tac/helpers/inline.ts:3534` — `emitInlineRecursiveInstanceMethod` (same restriction)

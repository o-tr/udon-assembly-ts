---
created: 2026-05-07T03:00:02+09:00
updated: 2026-05-07T03:00:02+09:00
status: open
severity: medium
component: transpiler / TAC optimizer
related_branch: feat/readonly-array-folding
---

# Transitive aliases created by copy propagation are not tracked by readonlyArrayFolding

## Summary

`readonlyArrayFolding` tracks only the original constructor temporary and one
direct alias (the first `Assignment`/`Copy` to a named variable). If copy
propagation — which runs later in the same iteration — creates a second-level
alias (`b = scores` where `scores` is the tracked alias), reads through `b`
are never folded, even on subsequent optimizer iterations.

## Example

```
// Iteration 1
t0 = call __ctor_SystemInt32Array(3)
t0[0] = 10; t0[1] = 20; t0[2] = 30
scores = t0
b = scores          // created by copy propagation later in iteration 1
t1 = b[0]           // not folded — b is not tracked

// Iteration 2
// readonlyArrayFolding re-identifies t0 as a candidate, tracks scores as alias
// but b = scores is still a separate copy — b is still not tracked
```

## Why it happens

- `readonlyArrayFolding` runs after SCCP but before copy propagation in the
  pass ordering.
- Copy propagation may create new aliases of the array variable.
- On iteration 2+, `readonlyArrayFolding` re-scans from scratch, but it only
  records one alias per candidate (the first `Assignment`/`Copy` whose `src`
  matches the constructor temporary).

## Impact

Conservative but correct — reads through transitive aliases are left as
runtime array accesses instead of being folded to constants. No miscompilation.
The AST-level `analyzeNativeArrayIneligibility` filter prevents user-level
aliasing from reaching `NativeArrayTypeSymbol`, so this gap only affects
optimizer-internal copies.

## Possible fixes

1. **Extend alias tracking to a set**: instead of a single `aliasName`, track
   `Set<string>` and grow it whenever a new `Assignment`/`Copy` from any
   tracked name is encountered in post-init.
2. **Run readonlyArrayFolding after copy propagation**: copy propagation would
   have already inlined `b → scores`, so the ArrayAccess operand becomes
   `scores` directly.
3. **Accept the limitation**: document as known conservative behavior.

## Relevant files

- `src/transpiler/ir/optimizer/passes/readonly_array_folding.ts` — alias tracking (single `aliasName`)
- `src/transpiler/ir/optimizer/passes/copy_propagation.ts` — creates transitive copies
- `src/transpiler/ir/optimizer/tac_optimizer.ts` — pass ordering (readonlyArrayFolding before copy propagation)

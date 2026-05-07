---
created: 2026-05-08T01:00:00+09:00
updated: 2026-05-08T01:00:00+09:00
status: open
severity: high
component: transpiler / D3 method dispatch / SoA
related_branch: d3-dispatch-residual-failures
related_issue: 2026-05-07T232003-d3-dispatch-residual-failures.md
---

# SoA per-class counter collision causes wrong-class dispatch in D3 method dispatch loop

## Summary

Each SoA class maintains its own `__soa_<ClassName>__counter` that starts at 1
and increments once per construction. When two or more different SoA classes are
constructed in the same call context (e.g. inside a shared constructor or the
same method), each class's first instance gets handle=1, its second gets
handle=2, etc. The D3 method dispatch loop (`tryD3MethodDispatch` in
`call.ts:1482`) compares runtime handles by value only — no class tag — so the
first candidate in iteration order whose `__handle` variable equals the runtime
value wins, regardless of whether that candidate's class is correct.

## Symptom

No `D3 method dispatch miss` log appears (handle values match), but the *wrong*
class's method body executes. Concretely: if `IYaku` is implemented by 20 yaku
classes all constructed once per `Registry` constructor, and the preamble loop
forces `Registry` into SoA (therefore also all yaku classes), then:

- All preamble yaku instances have handle=1 (first of each class)
- All main-code yaku instances have handle=2 (second of each class)

When `yakuMap.get(name)` returns a yaku handle (2) and the dispatch loop runs,
it encounters the main-code `TanyaoYaku` instance (also handle=2) before any
other main-code yaku. Since `2 == __inst_TanyaoYaku_N__handle` (`== 2`) is the
first match, **every yaku dispatch calls `TanyaoYaku.check()`** regardless of
which yaku the handle actually belongs to.

## Distinction from #232003

Issue #232003's fix (`!soaClasses.has(info.className)` guard) eliminates the
dispatch *miss* — the pre-fix code compared against compile-time `instanceId`
constants that never matched SoA counter values at runtime. After that fix,
dispatch *hits* — just the wrong class for non-first-created yaku types. The two
bugs coexist; this issue tracks the residual wrong-class routing.

## Root cause

`__soa_<ClassName>__counter` is per-class. Two different SoA classes can
independently produce the same counter value for the Nth instance of each.
The dispatch comparison `runtimeHandle == __inst_ClassName_K__handle` checks
only the integer counter value, not which class the handle was issued by.

## Reproduction

```typescript
type IFoo = { doIt(): number };
class Alpha implements IFoo { doIt(): number { return 1; } }
class Beta  implements IFoo { doIt(): number { return 2; } }

class Owner {
  private a: Alpha = new Alpha();  // Alpha counter → 1
  private b: Beta  = new Beta();   // Beta counter  → 1  ← COLLISION
  get(): IFoo { return this.a; }   // or this.b
}

@UdonBehaviour()
class Main extends UdonSharpBehaviour {
  Start(): void {
    // preamble forces Owner (and Alpha, Beta) into SoA
    for (let i = 0; i < 1; i++) { const _w = new Owner(); }
    const o = new Owner();  // Alpha_main.handle=2, Beta_main.handle=2 ← COLLISION
    const f: IFoo = o.get();
    Debug.Log(f.doIt());  // should log 1 or 2 depending on which get() returns,
                          // but both dispatch to Alpha (first candidate with handle=2)
  }
}
```

## Fix options

### Option A — Global SoA counter (minimal change)

Replace per-class `__soa_<ClassName>__counter` with a single
`__soa_global__counter` incremented atomically across all SoA classes. Each
construction assigns a globally unique handle. No two instances from any class
can collide.

- Pro: no dispatch-side changes; eliminates collision at the source.
- Con: all SoA classes share one counter variable; requires init-guard
  coordination if classes are constructed from different entry points.

### Option B — Class discriminator tag

Alongside the integer handle, track a compile-time class ID (e.g. stable hash
of class name). The dispatch comparison becomes:

```
cond = (runtimeHandle == __inst_ClassName_K__handle) &&
       (runtimeClassId == CLASS_ID_ClassName)
```

- Pro: per-class counters unchanged; handles remain small.
- Con: every dispatch comparison doubles in instruction count; requires
  threading the class ID through all dispatch sites and all return paths that
  carry inline instance values.

### Option C — Per-class instance-count cap enforcement (partial)

The existing instance limit (≤100 per class) prevents counter overflow but does
not prevent cross-class collision. Even with the cap, class A's handle=1 and
class B's handle=1 collide if both are SoA.

This option is not a fix on its own; documenting for completeness.

### Recommended: Option A

A global counter is the lowest-risk, lowest-code-change fix. The
`__soa_global__counter` variable is initialised once (to 1) across all SoA
init blocks and shared. Requires:
1. Replace `__soa_<ClassName>__counter` init to `__soa_global__counter` (if
   not already initialised) in `helpers/inline.ts` SoA init block.
2. Replace per-class counter increment with the global one.
3. All existing SoA read/write paths that use the counter for index arithmetic
   still work, since the counter value is only used as a DataList index via the
   stored `__handle` — and the DataList remains per-class.

## Where to investigate

- `src/transpiler/ir/ast_to_tac/helpers/inline.ts` — SoA init block (counter
  declaration and initial value assignment) and counter increment after
  construction.
- `src/transpiler/ir/ast_to_tac/visitors/call.ts:1482` —
  `tryD3MethodDispatch` loop (dispatch comparison site).
- `src/transpiler/ir/ast_to_tac/visitors/expression.ts:3244` —
  `uninst_prop` dispatch (verify whether the same collision occurs there).

## Severity

High. Affects all test cases where multiple SoA interface implementors are
constructed in the same context (which is the common pattern in mahjong-t2
yaku/scoring code). After #232003's fix eliminates the dispatch-miss errors, VM
test failures caused by wrong-class dispatch will surface with different symptoms
(incorrect return values, wrong boolean results from `check()` calls).

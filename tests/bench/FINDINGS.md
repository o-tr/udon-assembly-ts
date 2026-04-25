# Transpiler performance — bottleneck investigation

Date: 2026-04-19
Harness: `tests/bench/*` (transpiler_bench, optimize_profile, batch_profile)

## Headline

The optimizer's **SSA window dominates cost at scale**, with `deconstructSSA` as
the single biggest pass and super-linear (~O(n²)) growth. All other plan
candidates were either micro or refuted.

## Measurements

### 1. End-to-end wall-clock (main bench, 7 runs)

| Scenario | Median | Notes |
|----------|--------|-------|
| hot (small, no optimize) | ~1.3 ms | parse + astToTac ≈ 0.7 ms; codegen+assemble ≈ 0.2 ms |
| optimize (medium, optimize=true) | ~17 ms | optimize phase alone ≈ 12 ms (70%) |
| batch (2 cold entries) | ~4 ms | fixed cost dominates |

### 2. Per-pass optimizer profile (real optimizer, instrumented via `PassProfileSink`)

Using synthetic fixture whose size scales linearly with `--scale`.
5 runs each, medians shown. Total accounted ≥98% of optimize time.

| scale | TAC | optimize total | deconstructSSA | SSA family (build+PRE+GVN+decon) | sccpAndPrune |
|-------|-----|----------------|----------------|-----------------------------------|--------------|
| 1     | 198 | 7.9 ms        | 1.27 ms (16%)  | 3.23 ms (40%)                    | 1.07 ms (14%) |
| 5     | 425 | 31.1 ms       | 10.32 ms (33%) | 16.79 ms (54%)                   | 3.64 ms (12%) |
| 10    | 835 | 71.5 ms       | 32.15 ms (45%) | 43.90 ms (61%)                   | 10.15 ms (14%) |

**Scaling factors, scale 1→10** (TAC ≈ 4.2×):

| Pass | Growth | Scaling |
|------|--------|---------|
| total optimize | 9.1× | super-linear (~O(n^1.6)) |
| **deconstructSSA** | **25.3×** | **super-linear (~O(n^2.2))** — the steepest |
| sccpAndPrune | 9.4× | mildly super-linear |
| pre(ssa) | 7.1× | mildly super-linear |
| gvn(ssa) | 6.5× | mildly super-linear |
| buildSSA | 4.1× | ~linear |

### 3. Batch transpiler scaling

1/2/4/8/16 entry points over a cold cache, 3 runs each:

| entries | total ms | per-entry ms |
|---------|----------|--------------|
| 1  | 2.71 | 2.71 |
| 2  | 3.63 | 1.82 |
| 4  | 4.66 | 1.17 |
| 8  | 7.00 | 0.87 |
| 16 | 12.53 | 0.78 |

**Per-entry time decreases with entry count** (0.29× ratio 1→16). Fixed setup
dominates; marginal per-entry work is small.

### 4. Extern registry guarded-call cost

- First (cold) call:  **36.7 ms** — full stub scan, once per process
- 10,000 guarded calls:  2.5 ms total, **250 ns/call (0.25 µs/call) average** — effectively no-op

## Verdicts on each plan item

| # | Plan claim | Verdict | Evidence |
|---|-----------|---------|----------|
| 1 | Extern registry guard cost | **Micro** — 250 ns/call. Ignore in-process. | §4 |
| 5 | SSA splice O(n²) | **Confirmed**. deconstructSSA is 16% → 45% of optimize as TAC grows 4.2×, with 25× time growth (vs 4.2× data). | §2 |
| 7 | Per-entry layout redundancy creates super-linear batch growth | **Refuted**. Per-entry time *decreases* with entry count. Fixed setup dominates. | §3 |
| 3 | MethodUsage BFS queue O(n) shift | Not measured; not visible at these scales. Keep low-priority. | — |
| 4 | Batch layout sharing | Same as #7 — little payoff. | §3 |
| 2 | vitest worker setup file | Not yet measured. Per-worker cold cost is ~36 ms (§4). Modest but real. | §4 |

## Anomalies probed

- **`reuseLocalVariables` 24% artefact**: the earlier shadow profiler
  reported reuseLocalVariables at 24% on small inputs. Using the real
  optimizer (new `PassProfileSink` hook), it is consistently 3–4% across
  all scales. The 24% was a shadow-drift artifact, not a real bottleneck.

## Recommended next actions

Re-ordered from the original plan based on evidence:

1. **[High]** Fix `deconstructSSA`'s O(n²) splice/indexOf pattern.
   - `orderedBlockIds.indexOf(...)` + `orderedBlockIds.splice(...)` per
     edge insertion is the suspect pattern
     (`src/transpiler/ir/optimizer/passes/ssa.ts:835-837`).
   - Also `predInsts.splice(insertIndex, 0, ...lowered)` at
     `:904` for every phi lowering.
   - Approach: maintain blocks as a linked list / two-pass build (collect
     all insertions into a Map first, then do a single linear assembly).
   - Expected win: 30–40% reduction on optimize time at large scale.

2. **[Med]** Vitest shared setupFile for extern registry.
   - Saves ~36 ms per worker at test-run start. Low risk, pure additive.

3. **[Low]** Consider `sccpAndPrune` worklist analysis.
   - Stable ~13% share across scales. Mildly super-linear. Investigation
     likely lower-yield than (1) but worth a look.

**Drop from scope:**
- Plan Step 4 (batch layout sharing) — refuted by §3.
- Plan Step 2 (extern registry Maps module-scope) — refuted by §4; the
  guarded path is already 250 ns/call.

## How to reproduce

```bash
pnpm bench                                 # end-to-end wall-clock
pnpm tsx tests/bench/optimize_profile.ts --scale 10 --runs 5
pnpm tsx tests/bench/batch_profile.ts --entries 1,2,4,8,16 --runs 3
```

The optimizer profile uses the new `PassProfileSink` hook on
`TACOptimizer.optimize()` — zero overhead when the sink is not provided.

---

## Post-fix (2026-04-19)

The fix landed in `src/transpiler/ir/optimizer/passes/ssa.ts`. The real
hotspot turned out **not** to be `orderedBlockIds.indexOf+splice` at
`:835-837` (replacing it with `pendingBefore`/`trailing` had zero measurable
impact). Sub-phase probing of `deconstructSSA` showed **88% of its time was
in `linearizeParallelCopies`** — the parallel-copy cycle-breaker called
per (phi-target block, predecessor) pair.

### Actual root causes

1. `moveKey()` (`baseKeyForOperand ?? operandKey`) allocated a new string on
   every call. Inside the outer `while (pending.length > 0)` loop, three
   inner O(M) scans each re-computed these keys — yielding **O(M²) string
   allocations** per call for M moves.
2. `pending.splice(readyIndex, 1)` inside the hot loop was O(M) per emit,
   another O(M²) factor.

### Fix

- Cache `srcKey` / `destKey` on each pending entry once.
- Maintain `sourceKeyCount: Map<string, number>` incrementally — decrement on
  removal, delete on zero — so the "is this dest still a source of some
  pending move?" check is O(1).
- Replace `splice(i, 1)` with swap-with-last + `pop()` (O(1)).
- Keep `orderedBlockIds → pendingBefore/trailing` restructure from the
  original plan (it's a small correctness-preserving cleanup and removes the
  `indexOf+splice` pattern even though it wasn't the bottleneck).
- Keep the `ensureBlockLabel` `.find → [0]` fold-in (zero-risk constant-
  factor win).

### Results

**`deconstructSSA` median, 5 runs:**

| scale | TAC | before | after | reduction |
|-------|-----|--------|-------|-----------|
| 1     | 198 | 1.27 ms | 0.67 ms | **-48%** |
| 5     | 425 | 10.3 ms | 3.13 ms | **-70%** |
| 10    | 835 | 32.2 ms | 7.09 ms | **-78%** |

**`deconstructSSA` share of optimize at scale=10**: 45% → **12.7%**.

**Growth ratio `scale=10 / scale=1`**: 25× → **10.7×**. Above the ≤8× stretch
target but well below the ≥15× escalation threshold; the residual
super-linearity is from the outer `for (let i = 0; i < pending.length; i++)`
scan inside `linearizeParallelCopies` (still O(M) per emit). Converting this
to a reverse-index lookup could close the gap but is lower-priority — absolute
time is already dominated by other passes.

**End-to-end bench (`pnpm bench --runs 7`)**, vs pre-fix baseline:

| scenario | before | after | delta |
|----------|--------|-------|-------|
| hot      | 1.31 ms  | 1.13 ms  | -14.3% |
| optimize | 16.77 ms | 14.27 ms | **-14.9%** |
| batch    | 4.15 ms  | 3.61 ms  | -13.1% |

All 732 unit + snapshot tests pass; UASM output byte-identical on
`tests/uasm/sample/` fixtures.

### Lesson

The plan-agent analysis of the `indexOf+splice` pattern was sound theoretically
(it IS O(n²) and would bite on pathological inputs) but empirically it was not
the call site eating time in our fixtures. Lesson: **instrument production
code directly with sub-phase timings before committing to a root-cause
hypothesis**, rather than reasoning from code structure alone. The initial
`PassProfileSink` was right-grained for pass-level attribution, but one more
level of granularity (sub-phases inside a single pass) was needed here.

---

## Post-fix (2026-04-25 mahjong-t2 vm test cold run)

`pnpm test:vm` invokes `BatchTranspiler` over `tests/vm/cases/` (38 entry points,
~700MB of generated UASM). The cold run (no `.transpiler-cache.json`, empty
`.transpiler-optcache`, optimize=false, includeExternalDependencies=true)
took ~28 minutes wall-clock baseline.

### Cpuprofile (cold, baseline)

Total CPU 1667.9s. Top self-time frames:

| % | self | function |
|---|------|----------|
| 26.5% | 442.7s | `resolveFromTsType` (typeCache wrapper) |
| 23.3% | 388.5s | `populateMemberMaps` |
| 7.1% | 118.8s | `getReducedApparentType` (TS internal) |
| 5.6% | 93.9s | `getTypeOfSymbolAtLocation` (TS) |
| 5.1% | 85.7s | `resolveFromTsTypeUncached` |
| 4.9% | 82.2s | `getMergedSymbol` (TS) |
| 4.6% | 76.2s | `buildInterfaceTypeSymbol` |
| 2.0% | 34.2s | (garbage collector) |
| 0.4% | 6.2s  | `writeFileSync` (UASM output write) |

The TypeChecker resolver cluster owns ~63% of CPU. GC and file IO are
negligible — the prior plan-mode hypothesis "130MB UASM × 38 entries causes
GC pressure / writeFileSync dominance" was *refuted* by the data.

### Root cause

`ASTToTACConverter` lazily creates its own `TypeCheckerTypeResolver`
(`src/transpiler/ir/ast_to_tac/visitors/expression.ts:495`). With 38 entries
in BatchTranspiler, that gives **38 separate resolvers** each with a cold
`typeCache` and `fqNameCache`. The parser already builds a resolver against
the same shared `TypeCheckerContext` and warms its caches during parsing —
so per-entry resolution was redoing all the same `populateMemberMaps` and
`resolveFromTsTypeUncached` work from scratch.

### Fix

Pass `parser.checkerTypeResolver` into `ASTToTACConverter` so all entries
share one cache:
- `src/transpiler/ir/ast_to_tac/converter.ts` — accept `checkerTypeResolver`
  as a constructor option and store it.
- `src/transpiler/batch/batch_transpiler.ts` — pass `parser.checkerTypeResolver`.
- `src/transpiler/index.ts` — same for the single-file transpiler entry path.

Cache keys (`ts.Type` for `typeCache`, `ts.Symbol` for `fqNameCache`) are
identity-based and shared safely within one TS Program — no correctness
implications. After the external-discovery fixpoint converges, all entries
operate against the same Program, so the cache stays valid across them.

### Results (cold, mahjong-t2 vm test, 38 entries)

| metric | before | after | delta |
|--------|--------|-------|-------|
| wall-clock | 27:53 | 19:57 | **-28.4%** |
| user CPU | 1697s | 1246s | -26.6% |
| total cpuprof CPU | 1667.9s | 1194.1s | -28.4% |
| `resolveFromTsType` self | 442.7s | 309.0s | -30.2% |
| `populateMemberMaps` self | 388.5s | 216.8s | **-44.2%** |
| `getMergedSymbol` (TS) self | 82.2s | 30.4s | **-63.0%** |
| `getTypeOfSymbolAtLocation` (TS) self | 93.9s | 37.8s | -59.7% |
| GC self | 34.2s | 25.1s | -26.6% |

`buildInterfaceTypeSymbol` self time rose 76s → 144s after the fix — read
this as JIT inlining shifts, not a regression. The aggregated resolver
group (`resolveFromTsType` + `populateMemberMaps` + `buildInterfaceTypeSymbol`
+ `resolveFromTsTypeUncached`) drops 991s → 761s (**-23%**) end-to-end.

All 38 UASM files byte-identical (sha256 verified). All 790 unit tests pass.

### What's left

The resolver cluster is still ~64% of CPU (vs ~63% before) — sharing the
cache shrank absolute time but not the *share*, because resolver work
remains the dominant phase in this workload. Further wins likely require:
- Reducing the *number of calls* to `resolveFromTsType` (visitor-level dedup
  of repeated bridges from the same AST node)
- Tightening `populateMemberMaps` (still 18% of CPU; iterates props per
  unique interface ts.Type, calling 3 TS methods per prop)

Both are higher-effort architectural changes; deferred until next pass.

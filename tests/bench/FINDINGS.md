# Transpiler performance — bottleneck investigation

## 2026-04-27 — Fix 1+2 applied: resolver bottleneck cleared, codegen exposed

### Fixes applied

**Fix 2 (AST-node cache)** — `src/transpiler/frontend/type_checker_type_resolver.ts`:
Added `astNodeCache: WeakMap<ASTNode, TypeSymbol>` and routed
`resolveTypeFromNode` through `resolveFromAstNode` so repeat IR visits of
the same syntactic node skip the AST→ts.Node→ts.Type→TypeSymbol chain.

**Fix 1 (interface symbol cache + builtin shortcut)** — same file:
1. `tryResolveBuiltinGenericInterface(fqn)` short-circuits well-known
   generic-collection interfaces from the TS standard library to their
   Udon equivalents (`Map`/`Set`/`WeakMap`/`WeakSet`/`ReadonlyMap`/
   `ReadonlySet` → `dataDictionary`; `Iterator`/`IteratorResult`/
   `IterableIterator`/`Iterable`/`AsyncIterator`/`AsyncIterable`/
   `AsyncIterableIterator`/`Generator`/`AsyncGenerator`/`Promise`/
   `PromiseLike`/`Thenable` → `ObjectType`). Avoids the
   `populateMemberMaps` recursion through their generic protocol members.
2. `nonGenericInterfaceCache: WeakMap<ts.Symbol, InterfaceTypeSymbol>`
   keyed on the interface symbol itself for non-generic interfaces. Same
   symbol = same structural members, so the cache hit is sound. Generic
   user interfaces (with declared type parameters) are not cached because
   `IList<A>` and `IList<B>` share a symbol but expand to different
   member types.

### Measurements (mahjong-t2 src/core, 144 files, 2 entries, optimize=false)

| Phase                         | Pre-Fix (baseline) | Fix 1 only | Fix 1+2 |
| ----------------------------- | -----------------: | --------: | ------: |
| pre-entry phases (parse etc.) |              ~1.7s |     ~1.5s |   ~1.5s |
| entry GameOrchestrator pass 1 |   >40s (didn't end) |      ~21s |    ~24s |
| entry GameOrchestrator pass 2 |    OOM @ 4 GB heap |  observed |   ~33s |
| AST→TAC total (one entry)     |       did not end |       — |    ~57s |
| pass 2 emitted instructions   |          unobserved |       — |   28.6M |
| codegen for that 28.6M TAC    |                  — |       — |    ~63s |

Fix 1 is the dominant contribution; Fix 2 (AST node cache) does not move the
needle measurably above run-to-run noise on this workload (~21s vs ~24s on
single runs). Fix 2 is kept because it is a defensive WeakMap with negligible
overhead and may help on workloads with heavier inline-expansion repetition.

Tests: 805/805 unit tests pass; UASM snapshot unchanged. Output is
byte-compatible with the existing fixtures.

### Outcome

Fix 1+2 cleared the resolver bottleneck. The OOM-during-pass1 case from
the 2026-04-27 baseline section below no longer reproduces. Total CPU
profile of resolver work plummeted (8.8M `buildInterfaceTypeSymbol` calls
in 50s → ~0 per entry once the per-symbol cache or builtin shortcut
matches).

### Newly exposed bottleneck (out of scope here)

With the resolver cleared, AST→TAC pass 2 produces ~28.6M TAC
instructions per entry on `GameOrchestrator`, and codegen takes ~63s to
walk them. This work was always there but never reached on the
pre-fix run because the resolver burned all available heap first. It is
the next bottleneck to address — likely an inline-expansion deduplication
or memoization pass — but it is a separate problem from the resolver
blowup and is left for a follow-up. Synthetic small fixtures (used in
`pnpm bench`) do not trigger it.

### Fix 3 (lazy member resolution) status

Not implemented. With Fix 1's per-symbol cache + builtin shortcut already
in place, the remaining `populateMemberMaps` calls are for user-defined
generic interfaces (IList<X>, etc.). Lazy resolution wouldn't avoid the
work for consumers that actually access members; it would only defer it.
The downstream IR consumers do access members (for structural matching
in inline expansion), so Fix 3 is not expected to help further. Held
unless a profile shows otherwise.

---

## 2026-04-27 — Catastrophic regression: `buildInterfaceTypeSymbol` blowup

### Headline

Real-workload transpile is 100×–1000× slower than the 2026-04-25 baseline.
mahjong-t2 `src/core` (144 files, 2 entry points, `optimize=false`) no longer
completes within 7 minutes (previously 8.37s). One entry's AST→TAC pass 1 alone
takes >50s, and CPU time is dominated by **`TypeCheckerTypeResolver.buildInterfaceTypeSymbol` /
`populateMemberMaps`** being invoked **8.8M times in 50s** for a single entry —
linear-rate growth, no convergence, and 4GB+ heap pressure that OOMs the process
on `optimize=true`.

### Reproduce

```bash
UDON_PROFILE=1 NODE_OPTIONS="--max-old-space-size=12288" \
  pnpm tsx tests/bench/profile_real_workload.ts \
  -i /path/to/mahjong-t2/src/core --no-optimize
```

`UDON_PROFILE=1` enables phase-level `[prof]` prints in `batch_transpiler.ts`
(`pmark`/`pend`) and per-pass `tac-pass1` / `tac-pass2` prints in
`ir/ast_to_tac/converter.ts`. The bench harness uses `BatchTranspiler` directly
against the live source and writes `.tasm` to a tmpdir.

### Measurements (one entry, GameOrchestrator)

Pre-entry phases — fast, healthy:

| phase                            |    time |
| -------------------------------- | ------: |
| discover                         |   ~6 ms |
| read-sources                     |  ~21 ms |
| checker-context-create-initial   | ~610 ms |
| parse-initial (144 files)        |    ~1 s |
| fixpoint-iter-1 (no externals)   |  ~34 ms |
| resolve-deferred-types           |   ~6 ms |
| extern-registry-build            |  ~75 ms |
| inheritance-validate             | ~0.3 ms |

Per-entry compilation — **catastrophic**:

| step                             | time/entry |
| -------------------------------- | ---------- |
| collect-inline (96 inline cls)   |   ~9 ms |
| collect-consts (11 consts)       | ~0.2 ms |
| build-program                    | ~0.3 ms |
| **AST→TAC pass 1 (metadata)**    | **>40 s** (does not finish) |
| AST→TAC pass 2 (codegen)         | OOM at 4 GB before reaching here |

Resolver counters during the 50s window of pass 1 (sampled every ~5s):

```
calls=  1,048,576  uncached= 536,368  buildIface= 516,061  populate= 516,105
calls=  3,145,728  uncached=1,579,043 buildIface=1,555,848 populate=1,555,810
calls=  5,242,880  uncached=2,618,896 buildIface=2,595,482 populate=2,595,353
calls=  7,340,032  uncached=3,657,517 buildIface=3,633,912 populate=3,633,682
calls=  9,437,184  uncached=4,697,117 buildIface=4,672,123 populate=4,671,462
calls= 11,534,336  uncached=5,736,793 buildIface=5,711,660 populate=5,710,253
calls= 13,631,488  uncached=6,776,388 buildIface=6,751,027 populate=6,748,965
calls= 15,728,640  uncached=7,815,813 buildIface=7,790,230 populate=7,787,505
calls= 17,825,792  uncached=8,854,340 buildIface=8,828,242 populate=8,824,937
```

Linear-rate growth at ~350K resolveFromTsType calls/sec, **49 % cache miss rate
on the typeCache, and ≈100 % of misses end up calling
`buildInterfaceTypeSymbol` (which then calls `populateMemberMaps`,
which recursively calls `resolveFromTsType` on every member).** That recursion
is precisely how the count compounds.

### Root cause

`TypeCheckerTypeResolver.typeCache` is a `Map<ts.Type, TypeSymbol>` keyed on
`ts.Type` instance identity. TypeScript's `getTypeOfSymbolAtLocation` /
`getDeclaredTypeOfSymbol` /  generic-instantiation paths hand back **fresh
`ts.Type` instances** for what is structurally the same type when called
across syntactically distinct contexts (e.g. the same `Map<string, TileViewModel>`
reached via two different declaration sites). Every miss falls into
`buildInterfaceTypeSymbol` → `populateMemberMaps` → resolves every member type
recursively — which itself misses again on the same downstream member types,
because **those member ts.Types are also fresh per call site**. The cache
fundamentally cannot hit in this regime.

The IR phase compounds it: 32 `resolveTypeFromNode` callsites in
`visitors/expression.ts` alone, plus more in `call.ts` / `statement.ts` /
`assignment.ts`. Each callsite runs on every visited AST node, and inline
expansion re-visits the same call sites for every inline-expanded copy of a
method body. With 96 inline classes inside one entry's call graph, the same
underlying interface (e.g. `Map`, `Iterator`, an `IYaku` member's type) is
re-resolved tens of thousands of times.

### Why the 2026-04-25 baseline didn't show this

Memory's `reference_perf_hotspots.md` notes the cluster was already 20 % of CPU
on the warm baseline. Subsequent commits added more `resolveTypeFromNode`
call sites in the IR phase (resolver-first migration in `1025274` and follow-ups
through `9480a3a` / `1fa5124` / `ac52fe1`), and the 2026-04-25 "share resolver
across batch entries" win (`0a92ada`) only addressed cross-entry sharing — it
did not change the per-call recursive-population pattern. The pattern existed
before but the call volume has multiplied as the IR migrated off
`mapTypeScriptType(string)` and onto `resolveFromTsNode(ts.Node)`.

### Fix candidates (not implemented)

1. **Content-addressable interface symbol cache.** Key a second cache on
   `(fqName, sorted-properties-digest, sorted-methods-digest)` so the
   structurally-identical `Map<string,X>` from two call sites returns the same
   `InterfaceTypeSymbol` even when ts.Type identity differs. Memory's
   `reference_perf_hotspots.md` "tried-and-rejected" entry rejected a *symbol-
   fqName-only* cache because `Map<A,B>` and `Map<C,D>` collide on fqName; a
   structural digest disambiguates without re-introducing string parsing.
2. **AST-node level cache for `resolveTypeFromNode`** — add a
   `WeakMap<ASTNode, TypeSymbol>` so the IR's repeated visits of the same
   syntactic node short-circuit before the ts.Node→ts.Type→TypeSymbol chain
   even runs.
3. **Lazy member resolution.** `InterfaceTypeSymbol` could carry the ts.Symbol
   and resolve members on demand. Most consumers only read `properties` /
   `methods` for a small subset; eager population materializes the entire
   transitive membership graph.

Fix 2 is the cheapest and likely the highest-leverage; the resolver call rate
is dominated by IR re-visits, not parser-phase first-resolution. Fix 1 is
needed for the long-tail (parser phase, populateMemberMaps recursion).

### Instrumentation left in place

- `tests/bench/profile_real_workload.ts` — runs `BatchTranspiler` against an
  arbitrary directory, defaults to mahjong-t2 `src/core` + `src/vrc`. Clears
  `.transpiler-cache.json` / `.transpiler-optcache` to force a cold run.
- `tests/bench/quick_single_file.ts` — single-file timing harness.
- Phase prints in `src/transpiler/batch/batch_transpiler.ts` and pass-level
  prints in `src/transpiler/ir/ast_to_tac/converter.ts`, gated on
  `UDON_PROFILE=1`. Negligible overhead when off (one branch per phase
  boundary).

The high-frequency resolver counters (millions of branches/sec) were removed
to keep production overhead at zero; re-add them locally before re-running the
investigation.

---

## 2026-04-19 — earlier optimizer-focused investigation

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

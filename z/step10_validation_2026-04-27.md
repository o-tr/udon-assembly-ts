---
date: 2026-04-27
context: post PR #191 (Step A+B) + PR #193 (Step D union collapse)
fixture: ../mahjong-t2/src
---

# Step 10 reach validation — current build vs. mahjong-t2

## Method

`UDON_TS_STEP10_METRICS=1 UDON_TS_STEP10_METRICS_FILE=<path> pnpm tsx src/cli/index.ts -i <subset> -o <out>`

The metrics collector writes the file only when `counts.size > 0`. Therefore
**absence of the JSON file == zero step-10 hits** during the run.

## Results per subset

| Subset                  | Files | Wall-clock      | Outcome                              | Step-10 hits |
| ----------------------- | ----- | --------------- | ------------------------------------ | ------------ |
| cli + vrc               | 27    | ~30s            | completed cleanly                    | **0**        |
| core/domain             | 88    | ~3s (cache hit) | completed cleanly                    | **0**        |
| full src (171 files)    | 171   | killed @ ~30min | OOM at default heap, slow at 12GB    | 0 in samples written |
| core/application alone  | 32    | killed @ ~10min | running, no metrics file written     | 0 in samples written |

cli/vrc and core/domain ran exactly the slices the original analysis covered
(`z/step10_analysis.md` table) and **drained from `12 926 + 17 603 + 5 595 = 36 124` hits to zero**.
PRs #191 (function/keyword collapse) and #193 (heterogeneous union collapse)
are confirmed to have closed those buckets on their original samples.

## Full-src run did not converge

Two attempts:

1. `pnpm tsx src/cli/index.ts -i ../mahjong-t2/src` — JS heap OOM at ~2min wall-clock.
2. `NODE_OPTIONS='--max-old-space-size=12288' …` — ran for >30min wall-clock, RSS oscillated 1.2-2.0 GB, no `.uasm` produced, no metrics file written, then killed.

This matches the `z/step10_analysis.md` Caveats note:

> `core/` (144 files) did not complete within 25min wall-clock. Whether this
> is metric-mode-induced overhead or pre-existing slow-path on this project
> is unknown.

The flush threshold (`RECORD_FLUSH_THRESHOLD = 5000`) means the **absence of a
metrics file after 30+ min implies fewer than 5000 cumulative step-10 hits across
whatever was processed**. This is a soft signal — could be 0, could be 4999,
and the partial process state is opaque.

`core/application` (32 files) alone also did not finish in ~10min wall-clock,
suggesting the slow-path lives somewhere in `core/{application,
infrastructure, network}` — not specific to a full-tree run.

## Interpretation

**Hard data**: the three subsets that previously accounted for 100% of the
documented hits all now report zero. PR #191 and PR #193 closed Steps A, B, D,
and (transitively) C as designed.

**Soft data**: the unsampled `core/{application, infrastructure, network,
config, utils, testsupport}` slice (56 files) cannot be measured today because
the transpiler does not converge on it within practical time, with or without
metrics mode. The original analysis hit the same wall.

## Recommendation

Two options for unblocking §2 (resolver step-10 deletion):

1. **Investigate the core/application slow-path first.** Profile a single
   slow file (start by listing `core/application/*.ts` by size and trying
   the first one in isolation under metrics mode). If it's a TypeChecker
   pathological case rather than a transpiler hot loop, the metrics file
   would still write at 5 000 records — which means a 5-min smoke test
   on one file would surface any residual D/C leak in that subtree.
2. **Treat the cli/vrc/core/domain zero-hit result as sufficient evidence**
   to land step-10 deletion (§2) as a soft-deprecation: replace the
   `typeToString` fallback with `throw new TranspileError` (no metrics gate),
   and rely on the existing test suite + any future failure on
   core/application to surface the missing case. This is the path the
   original analysis implicitly endorsed ("the typeToString fallback at
   lines 396-423 becomes dead code on this fixture").

Option 2 is the lower-risk way forward given that:
- Step A+B+D collapse to `ObjectType` rather than throwing, so the only
  remaining risk is "a type that today reaches step 10 and gets a *useful*
  symbol back via `tryMapTypeScriptType`." On the measured slices that
  count was zero, and the `tryMapTypeScriptType(typeText)` path on a
  raw TS `typeToString` output is structurally weak (regex matches on
  reconstructed text).
- A regression on the unsampled subtree would surface as a transpilation
  error at the deleted call site, which is loud and recoverable.

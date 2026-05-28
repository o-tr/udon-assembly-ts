# Mahjong Optimizer Completion Plan

## Scope

Continue from the pass2 TAC explosion fix and make `../mahjong-t2` transpilation progress with optimizer enabled. Identify the optimizer bottleneck or failure mode and implement a narrow fix if one is clear.

Repository rule context: `docs/coding-agent/rules/index.md` is not present/readable, so validation is selected from project commands and bounded profile runs.

Research waived: subagent dispatch is not available unless explicitly requested; the Orchestrator will inspect and profile locally.

## Task_1

type: research
owns:
- `src/transpiler/ir/optimizer/**` read-only unless adding diagnostics
- `src/transpiler/ir/ast_to_tac/**` read-only unless needed
- `../mahjong-t2/**` read-only
depends_on: []
acceptance:
- Run optimizer-enabled `../mahjong-t2` profile with the gated outline envs.
- Identify whether timeout/failure is in a specific optimizer pass, memory, codegen after optimization, or validation.
validation:
- kind: profiling
  required: true
  owner: orchestrator
  detail: Bounded optimizer-enabled transpile/profile run.

## Task_2

type: impl
owns:
- `src/transpiler/ir/optimizer/**`
- `src/transpiler/ir/ast_to_tac/**`
- `tests/unit/transpiler/**`
depends_on:
- Task_1
acceptance:
- Implement a scoped optimizer fix only if Task_1 identifies a clear bottleneck/correctness issue.
- Keep risky behavior gated or conservative.
validation:
- kind: tests
  required: true
  owner: orchestrator
  detail: Targeted Vitest and `pnpm build`; rerun bounded `../mahjong-t2` optimizer profile.

## Task_3

type: review
owns:
- touched files read-only
depends_on:
- Task_2
acceptance:
- Local review of changes and residual risk.
validation:
- kind: manual-review
  required: true
  owner: orchestrator
  detail: Reviewer subagent waived because delegation was not explicitly requested.

## Progress Log

- 2026-05-29: Plan created after pass2/no-optimize transpilation completed.
- 2026-05-29: Added pass-level optimizer profiling for batch transpilation under `UDON_PROFILE`.
- 2026-05-29: Found optimizer-enabled `../mahjong-t2` first stalled in SCCP on `GameOrchestrator` with 1,200,317 TAC instructions.
- 2026-05-29: After skipping SCCP for large inputs, found `readonlyDataCollectionFolding` took about 48s and later CFG/liveness-heavy passes hit V8 OOM near 4GB.
- 2026-05-29: Added conservative 500k-instruction guards for SCCP, readonly DataCollection folding, CFG-heavy optimizer passes, loop-heavy passes, and post temp reuse passes. Guards are overrideable by env vars.
- 2026-05-29: Fixed guard basis to use the original optimizer input size as well as current size; this prevents post-pass temp reuse from running after DCE shrinks a large input just below the threshold.
- 2026-05-29: `../mahjong-t2` optimizer-enabled transpile completed with rc=0 using `UDON_PROFILE=1 UDON_FAST_METADATA_PASS=1 UDON_SHARED_INSTANCE_OUTLINE=1 UDON_ALLOW_OUTLINE_PARAM_FIELDS=1`. Core total was 82,970.6ms; `GameOrchestrator` optimized in 42,798.1ms and `NetworkGameOrchestrator` optimized in 15,273.3ms.

## Decision Log

- 2026-05-29: Proceed without subagents due to tool policy; record as harness waiver.
- 2026-05-29: Prefer conservative pass skipping for generated TAC above 500k instructions over increasing Node heap. This preserves optimizer completion by still running linear/local passes while avoiding passes with known high memory or CFG/liveness cost.

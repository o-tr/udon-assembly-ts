# Mahjong T2 Transpile Timeout Investigation Plan

## Scope

Investigate timeout during transpilation of `../mahjong-t2`, identify bottlenecks, and implement a focused performance improvement when the cause is clear and low-risk.

Research waived: subagent spawning is not available for this task because the runtime only permits subagents when the user explicitly asks for delegation. The Orchestrator will perform the research locally and record evidence.

Quality routing note:
- Routing level: L1, with performance risk elevated to medium if the fix touches shared transpiler paths.
- In-scope docs: TypeScript/JavaScript baseline, testing/validation baseline.
- Out-of-scope docs: UI, security, migration, backend/frontend framework gates because this is CLI/transpiler performance work.
- Top risks: performance, contract/API compatibility.

## Task_1

type: research
owns:
- `../mahjong-t2/**` (read-only)
- `src/transpiler/**` (read-only)
- `tests/**` (read-only)
depends_on: []
acceptance:
- Reproduce or closely approximate the timeout path for `../mahjong-t2`.
- Capture timing evidence that identifies the dominant phase or operation.
- Identify candidate optimization(s) and their risk.
validation:
- kind: profiling
  required: true
  owner: orchestrator
  detail: Run targeted transpilation/profile commands and record timing or sampled evidence.

## Task_2

type: impl
owns:
- `src/transpiler/**`
- `tests/**`
depends_on:
- Task_1
acceptance:
- Implement the narrowest safe optimization for the confirmed bottleneck.
- Preserve existing transpiler behavior and public API.
- Add or update focused tests only if behavior changes or a regression can be cheaply encoded.
validation:
- kind: tests
  required: true
  owner: orchestrator
  detail: Run relevant Vitest/typecheck/build or targeted performance command based on changed surface.

## Task_3

type: review
owns:
- `src/transpiler/**` (read-only)
- `tests/**` (read-only)
depends_on:
- Task_2
acceptance:
- Review the patch for correctness, behavior drift, and hidden hot-path costs.
- Verify validation evidence is sufficient for the change.
validation:
- kind: manual-review
  required: true
  owner: orchestrator
  detail: Independent local review; Reviewer subagent waived because delegation was not explicitly requested.

## Task Waves

Wave 1: Task_1
Wave 2: Task_2
Wave 3: Task_3

## Progress Log

- 2026-05-28: Plan created. Repository rule files under `docs/coding-agent/rules/` were not present/readable from the initial checks.
- 2026-05-28: Reproduced the timeout/OOM path against `../mahjong-t2`. Directory discovery, file reads, TypeScript checker, parse, dependency fixpoint, extern resolution, and validation complete in roughly 1.3s total; the dominant cost is AST-to-TAC conversion for the `GameOrchestrator` entry.
- 2026-05-28: Profiling showed repeated inline expansion through `YakuRegistry.createDefault()` / `YakuRegistry.register()` during `GameOrchestrator` conversion. One metadata pass for `onTurnActionSelected` emitted about 13.3M TAC instructions before `onCallActionSelected` continued the same pattern.
- 2026-05-28: `UDON_FAST_METADATA_PASS=1` reduced the first metadata pass to about 3.0M emitted instructions and 5.9s in the profiled run, but the normal transpile still exhausted the default Node heap at about 92s. `--no-optimize` also exhausted the heap, so the TAC optimizer is not the primary bottleneck.
- 2026-05-28: No low-risk transpiler patch was retained. A complete fix needs either source-level construction sharing in `mahjong-t2` or a more substantial transpiler change to outline/share inline instance bodies safely across receiver prefixes and inline-class return values.

## Decision Log

- 2026-05-28: Proceeding without subagents due to tool policy; this is recorded as a harness waiver.
- 2026-05-28: Task_2 implementation is intentionally skipped for this turn because the safe short-path optimization only improves metadata pass time and does not prevent the pass2 TAC explosion/OOM. Experimental code was not retained.

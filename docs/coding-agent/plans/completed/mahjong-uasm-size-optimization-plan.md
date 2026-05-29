# mahjong-t2 UASM Size Optimization Plan

## Context

User asked to continue investigation and improvement for oversized generated
UASM based on mahjong-t2 output. Plan approval is delegated by the user's
"direction is up to you" instruction.

Research waiver: subagents are unavailable unless explicitly requested by the
user in this runtime; all work stays in the main thread.

## Task_1

- type: impl
- owns:
  - `src/transpiler/ir/ast_to_tac/visitors/expression.ts`
  - `tests/unit/transpiler/**`
- depends_on: []
- acceptance:
  - Simple inline getters of the form `return this.<field>` avoid the generic
    getter body inlining path when a direct backing slot or SoA field read is
    available.
  - Behavior remains unchanged for non-simple getters, recursive getters, and
    getters that cannot be mapped to a backing field.
  - A focused regression test proves simple getter reads still produce correct
    UASM/TAC shape.
- validation:
  - kind: command
    required: true
    owner: orchestrator
    detail: Run a focused Vitest test covering inline/simple getter behavior.
  - kind: command
    required: true
    owner: orchestrator
    detail: Run TypeScript typecheck.

## Task_2

- type: research
- owns:
  - `tests/bench/FINDINGS.md`
  - local `/tmp` measurement artifacts
- depends_on:
  - Task_1
- acceptance:
  - Attempt a bounded mahjong-t2 measurement or explain why it cannot complete
    within a practical local turn.
  - Record observed before/after signals or residual blocker clearly.
- validation:
  - kind: command
    required: false
    owner: orchestrator
    detail: Run a bounded `UDON_PROFILE=1` mahjong-t2 entry measurement if it
      completes within practical time.

## Task Waves

- Wave 1: Task_1
- Wave 2: Task_2

## Progress Log

- 2026-05-26: Plan created. Starting with simple getter fast path because it is
  localized and supported by existing mahjong-t2 profiling notes.
- 2026-05-26: Implemented SoA readable-field resolution for simple getters and
  added a regression test for any-escaped SoA getter reads. Focused Vitest and
  typecheck passed.
- 2026-05-26: Bounded mahjong-t2 full-entry measurement was not rerun after
  the change because previous attempts in this same session did not return from
  AST-to-TAC after several minutes. Used a synthetic SoA getter fixture as the
  measurable acceptance signal for this patch.

## Decision Log

- 2026-05-26: Full mahjong-t2 profiling previously failed to complete in this
  session; implementation will use focused unit validation first, then bounded
  measurement if feasible.
- 2026-05-26: Reviewer dispatch waived because this runtime only allows
  subagents when explicitly requested by the user. Local review is limited to
  focused tests, typecheck, and diff inspection.

## Closeout

- Task_1: done.
- Task_2: done with bounded measurement waiver; synthetic fixture proves the
  intended branch removes per-instance `uninst_prop_next` dispatch for simple
  SoA getters.
- Required validation:
  - `pnpm typecheck`: pass.
  - Focused Vitest getter/interface suite: pass.
  - Focused SoA known-bugs tests: pass.

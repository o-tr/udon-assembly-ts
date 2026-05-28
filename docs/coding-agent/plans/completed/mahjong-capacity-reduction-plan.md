# mahjong-t2 Capacity Reduction Plan

## Context

Continue reducing generated output size for mahjong-t2 after the bounded core
run started completing with experimental gates. The user delegated direction and
asked to keep going until practical progress is exhausted.

Research waiver: subagents are only allowed when explicitly requested in this
runtime. Repository exploration and implementation stay in the main thread.

Reviewer waiver: independent reviewer dispatch is unavailable under the same
runtime constraint; validation uses focused tests, diff review, and bounded
mahjong measurements.

Quality routing note:
- Routing level: L1.
- In-scope docs: orchestration-harness, plan-format, TypeScript/Javascript
  baseline, testing/validation baseline.
- Out-of-scope docs: UI/E2E, security, migrations, persistence, network
  contracts; this work is compiler/codegen performance and output size only.
- Top risks: performance/resource, compiler correctness.

## Task_1

- type: research
- owns:
  - local `/tmp` measurement artifacts
  - `docs/coding-agent/plans/active/mahjong-capacity-reduction-plan.md`
- depends_on: []
- acceptance:
  - Identify the next largest generated-output contributors from current
    mahjong-t2 profile logs or a bounded rerun.
  - Select one or two narrow compiler changes with measurable expected output
    reduction.
- validation:
  - kind: command
    required: true
    owner: orchestrator
    detail: Capture or reuse bounded mahjong profile evidence and record the
      selected target.

## Task_2

- type: impl
- owns:
  - `src/transpiler/ir/ast_to_tac/**`
  - `src/transpiler/codegen/**`
  - `tests/unit/transpiler/**`
- depends_on:
  - Task_1
- acceptance:
  - Implement a narrowly-scoped output-size reduction without changing default
    behavior unless covered by focused tests.
  - Preserve existing tests for outline, try/catch, SoA, and setImmediate.
  - Add or update regression coverage for the changed path.
- validation:
  - kind: command
    required: true
    owner: orchestrator
    detail: Run TypeScript typecheck and focused Vitest tests for touched
      compiler paths.

## Task_3

- type: test
- owns:
  - local `/tmp` measurement artifacts
  - `docs/coding-agent/plans/active/mahjong-capacity-reduction-plan.md`
- depends_on:
  - Task_2
- acceptance:
  - Run bounded mahjong-t2 core measurement with the experimental gates used in
    the previous pass.
  - Compare output/TAC/Udon instruction counts against the prior recorded
    2026-05-26 baseline.
- validation:
  - kind: command
    required: true
    owner: orchestrator
    detail: Bounded mahjong-t2 profile command completes or records the next
      concrete blocker.

## Task Waves

- Wave 1: Task_1
- Wave 2: Task_2
- Wave 3: Task_3

## Progress Log

- 2026-05-27: Plan created. Starting from previous core baseline:
  `GameOrchestrator` 698,677,577 bytes TASM and `NetworkGameOrchestrator`
  391,493,790 bytes TASM.
- 2026-05-27: Tested `UDON_OUTLINE_MAX_CANDIDATES=256`; it regressed
  `GameOrchestrator` to 21,376,456 TAC instructions before assembly, so
  broader outlining is not a reliable size-reduction path without better
  candidate filtering.
- 2026-05-27: Implemented opt-in assembler text reduction:
  `UDON_MINIFY_INTERNAL_SYMBOLS=1` renames internal data symbols in data,
  `PUSH`, and symbol `EXTERN` operands; `UDON_OMIT_INTERNAL_LABELS=1` omits
  non-exported label lines after jumps are resolved to numeric addresses.
- 2026-05-27: Reworked finally-only try lowering so `break` / `continue` use a
  generated finally trampoline instead of falling back to the heavy
  error-flag-per-instruction expansion.
- 2026-05-27: Bounded mahjong core run with the previous experimental gates plus
  assembler text reduction completed:
  - `GameOrchestrator`: 9,538,285 TAC instructions, 24,471,653 Udon
    instructions, 441,573,992 bytes TASM.
  - `NetworkGameOrchestrator`: 4,271,952 TAC instructions, 11,679,495 Udon
    instructions, 239,890,513 bytes TASM.
  - Total wall clock: 208.85s, entries=2, output=649.9 MiB.
  - Compared with the 2026-05-26 baseline, file bytes dropped from
    1,090,171,367 to 681,464,505 total bytes, a reduction of about 37.5%.

## Decision Log

- 2026-05-27: User delegated direction and asked to continue; plan approval is
  treated as waived for this continuation.
- 2026-05-27: The assembler text reduction is opt-in because existing tests and
  diagnostics often assert specific internal symbol names. Default readable
  output remains unchanged.
- 2026-05-27: Existing bounded mahjong run still reports unresolved labels for a
  small number of outline/for-of labels under the experimental outline gates.
  This appears independent of symbol minification because labels are resolved
  before omission, but it remains a correctness risk for the experimental
  mahjong path.

## Closeout

- Task_1: done.
- Task_2: done.
- Task_3: done.
- Required validation:
  - `pnpm typecheck`: pass.
  - `pnpm vitest tests/unit/transpiler/udon.test.ts tests/unit/transpiler/try_catch.test.ts tests/unit/transpiler/setImmediate-inline.test.ts tests/unit/transpiler/inline_outline.test.ts --hideSkippedTests`: pass.
  - `pnpm vitest tests/unit/transpiler/transpiler_known_bugs.test.ts --hideSkippedTests --testNamePattern 'SoA simple getter|SoA property read from any-annotated|SoA method dispatch from any-annotated'`: pass.
  - `git diff --check`: pass.
  - Bounded mahjong core run with `UDON_FAST_METADATA_PASS=1
    UDON_LIGHTWEIGHT_TRY=1 UDON_ALLOW_OUTLINE_PARAM_FIELDS=1
    UDON_SKIP_OUTLINE_METADATA_PASS=1 UDON_OUTLINE_MAX_CANDIDATES=64
    UDON_OMIT_INTERNAL_LABELS=1 UDON_MINIFY_INTERNAL_SYMBOLS=1
    NODE_OPTIONS=--max-old-space-size=12288`: pass for 2 entries.
- Residual risk:
  - The experimental outline gates still emit unresolved-label warnings in
    `GameOrchestrator`; further work should address that before treating the
    generated output as production-safe.

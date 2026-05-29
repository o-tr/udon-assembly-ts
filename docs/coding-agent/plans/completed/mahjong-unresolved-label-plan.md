# mahjong-t2 Unresolved Label Plan

## Context

Continue from the capacity reduction pass. The bounded mahjong-t2 core run now
finishes with much smaller TASM, but `GameOrchestrator` still reports unresolved
labels under the experimental outline gates. This is a correctness risk.

Research waiver: subagents are only allowed when explicitly requested in this
runtime, so investigation and implementation stay in the main thread.

Reviewer waiver: independent reviewer dispatch is unavailable under the same
runtime constraint; validation uses focused tests and bounded mahjong evidence.

## Task_1

- type: research
- owns:
  - `src/transpiler/ir/ast_to_tac/**`
  - `src/transpiler/codegen/**`
  - local `/tmp` measurement artifacts
- depends_on: []
- acceptance:
  - Identify which TAC or Udon instruction references labels that are missing
    from the final instruction stream.
  - Determine whether the issue comes from outline return dispatch, for-of
    lowering, label canonicalization, or codegen translation.
- validation:
  - kind: command
    required: true
    owner: orchestrator
    detail: Reproduce unresolved-label evidence with a bounded mahjong or
      focused fixture run.

## Task_2

- type: impl
- owns:
  - `src/transpiler/ir/ast_to_tac/**`
  - `src/transpiler/codegen/**`
  - `tests/unit/transpiler/**`
- depends_on:
  - Task_1
- acceptance:
  - Fix unresolved label generation without disabling the previous size
    reductions.
  - Add focused regression coverage for the missing-label case when practical.
  - Preserve existing outline, assembler, try/catch, SoA, and setImmediate
    behavior.
- validation:
  - kind: command
    required: true
    owner: orchestrator
    detail: Run TypeScript typecheck and focused Vitest tests.

## Task_3

- type: test
- owns:
  - local `/tmp` measurement artifacts
  - `docs/coding-agent/plans/active/mahjong-unresolved-label-plan.md`
- depends_on:
  - Task_2
- acceptance:
  - Run bounded mahjong-t2 core with the experimental gates and size-reduction
    flags.
  - Confirm no unresolved-label warnings remain, or record the next blocker.
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

- 2026-05-27: Plan created. Starting from unresolved labels observed in
  `GameOrchestrator`: several `outline_dispatch...` labels and one
  `forof_start...` label.
- 2026-05-27: Root cause identified: outlined bodies can be emitted while
  heavy try/catch lowering temporarily redirects `converter.instructions` to a
  local array. The deferred single-return-site optimization stored a numeric
  instruction index, then later patched that index in the main instruction
  array, overwriting unrelated instructions such as for-of labels.
- 2026-05-27: Fixed normal outlined methods and D3 method-dispatch outlines to
  retain the actual body-return `UnconditionalJumpInstruction` object and mutate
  its label directly, so patching works regardless of which instruction array
  owns the object.
- 2026-05-27: Bounded mahjong-t2 core run completed with no unresolved-label,
  failed, or fatal messages. Output remained about 649.9 MiB with the previous
  size-reduction flags.

## Decision Log

- 2026-05-27: User asked to continue; plan approval is treated as waived for
  this continuation.
- 2026-05-27: Focused regression coverage is covered by existing
  `inline_outline` single-return-site outline tests plus the bounded mahjong
  reproduction, because the defect requires outlined body emission inside a
  redirected instruction array and was not practical to isolate cheaply.

## Closeout

- Task_1: done.
- Task_2: done.
- Task_3: done.
- Required validation:
  - `pnpm typecheck`: pass.
  - `pnpm vitest tests/unit/transpiler/inline_outline.test.ts tests/unit/transpiler/try_catch.test.ts tests/unit/transpiler/udon.test.ts --hideSkippedTests`: pass.
  - `pnpm vitest tests/unit/transpiler/setImmediate-inline.test.ts tests/unit/transpiler/transpiler_known_bugs.test.ts --hideSkippedTests --testNamePattern 'setImmediate|SoA simple getter|SoA property read from any-annotated|SoA method dispatch from any-annotated'`: pass.
  - `git diff --check`: pass.
  - Bounded mahjong core run with `UDON_FAST_METADATA_PASS=1
    UDON_LIGHTWEIGHT_TRY=1 UDON_ALLOW_OUTLINE_PARAM_FIELDS=1
    UDON_SKIP_OUTLINE_METADATA_PASS=1 UDON_OUTLINE_MAX_CANDIDATES=64
    UDON_OMIT_INTERNAL_LABELS=1 UDON_MINIFY_INTERNAL_SYMBOLS=1
    NODE_OPTIONS=--max-old-space-size=12288`: pass for 2 entries; no
    unresolved-label warnings.
- Residual risk:
  - The mahjong path still relies on experimental opt-in flags for fast metadata
    and outline safety relaxation. It is now label-consistent under the bounded
    core run, but broader production hardening should make those gates safer or
    convert them into validated defaults.

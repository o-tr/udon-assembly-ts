# mahjong-t2 Transpile Progress Plan

## Context

Continue improving the mahjong-t2 transpilation path until it gets closer to a
complete run. Direction is delegated by the user's instruction.

Research waiver: subagents are unavailable unless explicitly requested by the
user in this runtime; investigation and implementation stayed in the main
thread.

## Task_1

- type: impl
- owns:
  - `src/transpiler/ir/ast_to_tac/helpers/inline.ts`
  - `src/transpiler/ir/ast_to_tac/converter.ts`
- depends_on: []
- acceptance:
  - Add a bounded fast metadata mode that can skip repeated metadata-only
    inline walks for bodies that do not allocate inline metadata.
  - Keep default outline behavior compatible with existing outline tests.
  - Expose profiling controls for bounded mahjong experiments.
- validation:
  - kind: command
    required: true
    owner: orchestrator
    detail: Run TypeScript typecheck and outline tests.

## Task_2

- type: impl
- owns:
  - `src/transpiler/ir/ast_to_tac/visitors/call.ts`
- depends_on:
  - Task_1
- acceptance:
  - Remove avoidable per-field `Array.from(fieldsToLoad)` allocation from SoA
    method dispatch preload checks.
  - Preserve existing SoA dispatch behavior.
- validation:
  - kind: command
    required: true
    owner: orchestrator
    detail: Run TypeScript typecheck and focused transpiler tests.

## Task_3

- type: impl
- owns:
  - `src/transpiler/ir/ast_to_tac/visitors/statement.ts`
  - `src/transpiler/batch/batch_transpiler.ts`
  - `src/transpiler/ir/ast_to_tac/visitors/call.ts`
  - `tests/unit/transpiler/setImmediate-inline.test.ts`
- depends_on:
  - Task_1
  - Task_2
- acceptance:
  - Emit simple finally-only `try` statements without the heavy nullable error
    flag expansion when the try body cannot return/throw/nest try-catch.
  - Allow bounded experiments to outline structural-param field users via an
    explicit environment gate.
  - Stream huge TASM outputs to disk when string assembly exceeds V8's maximum
    string size.
  - Accept block-bodied `setImmediate(() => { this.method(); })` callbacks by
    unwrapping the expression statement.
- validation:
  - kind: command
    required: true
    owner: orchestrator
    detail: Run TypeScript typecheck, focused try/catch, outline,
      setImmediate, and SoA regression tests.
  - kind: command
    required: true
    owner: orchestrator
    detail: Run a bounded mahjong-t2 core transpilation with the experimental
      environment gates.

## Task Waves

- Wave 1: Task_1
- Wave 2: Task_2
- Wave 3: Task_3

## Progress Log

- 2026-05-26: Reproduced the current mahjong-t2 core run reaching
  `GameOrchestrator` and hanging/OOMing after AST-to-TAC start.
- 2026-05-26: Added `UDON_FAST_METADATA_PASS=1` metadata-only skip for repeated
  pure inline bodies. In bounded mahjong profiling, `tac-pass1` now returns in
  about 8-10 seconds instead of not returning within several minutes.
- 2026-05-26: Added `UDON_OUTLINE_MAX_CANDIDATES` and
  `UDON_SKIP_OUTLINE_METADATA_PASS=1` controls for bounded outline experiments
  without changing default outline test behavior.
- 2026-05-26: Added `UDON_PROFILE=1` pass2 progress logging so large runs show
  forward motion instead of appearing hung.
- 2026-05-26: Removed a hot `Array.from(fieldsToLoad)` allocation inside SoA
  method dispatch preload filtering.
- 2026-05-26: Bounded mahjong run with
  `UDON_FAST_METADATA_PASS=1 UDON_SKIP_OUTLINE_METADATA_PASS=1
  UDON_OUTLINE_MAX_CANDIDATES=1` reached pass2 and emitted progress beyond 27M
  TAC instructions before the run was stopped manually. Full transpilation is
  still not complete.
- 2026-05-26: Added a lightweight finally-only try path and experimental
  `UDON_LIGHTWEIGHT_TRY=1` catch-only path to reduce temporary TAC array
  materialization in large mahjong methods.
- 2026-05-26: Added experimental `UDON_ALLOW_OUTLINE_PARAM_FIELDS=1` to permit
  mahjong-oriented outline candidates whose structural params read fields,
  leaving the default safety check unchanged.
- 2026-05-26: Added TASM assembly fallback to `assembleToFile` when
  `assembler.assemble` hits V8 `Invalid string length`.
- 2026-05-26: Fixed `setImmediate(() => { this.method(); })` lowering by
  accepting block statements that wrap the call in an `ExpressionStatement`.
- 2026-05-26: Bounded mahjong core run completed both detected entries with
  experimental gates:
  - `GameOrchestrator`: 9,538,283 TAC instructions, 24,471,660 Udon
    instructions, 698,677,577 bytes TASM.
  - `NetworkGameOrchestrator`: 4,271,952 TAC instructions, 11,679,495 Udon
    instructions, 391,493,790 bytes TASM.
  - Total wall clock: 271.80s, entries=2, output=1039.7 MiB.

## Decision Log

- 2026-05-26: Default fast metadata skip was gated behind
  `UDON_FAST_METADATA_PASS=1` because existing outline candidate tests depend on
  repeated metadata walks discovering nested outline candidates.
- 2026-05-26: Default outline candidate cap remains compatible with the existing
  tests; bounded mahjong experiments use `UDON_OUTLINE_MAX_CANDIDATES`.
- 2026-05-26: `UDON_ALLOW_OUTLINE_PARAM_FIELDS=1` remains experimental and
  opt-in because the conservative default protects outline aliasing cases that
  are not yet proven generally safe.
- 2026-05-26: Reviewer dispatch waived because this runtime only allows
  subagents when explicitly requested by the user.

## Closeout

- Task_1: done.
- Task_2: done.
- Task_3: done.
- Required validation:
  - `pnpm typecheck`: pass.
  - `pnpm vitest tests/unit/transpiler/inline_outline.test.ts --hideSkippedTests`: pass.
  - `pnpm vitest tests/unit/transpiler/try_catch.test.ts tests/unit/transpiler/inline_outline.test.ts --hideSkippedTests`: pass.
  - `pnpm vitest tests/unit/transpiler/setImmediate-inline.test.ts --hideSkippedTests`: pass.
  - `pnpm vitest tests/unit/transpiler/transpiler_known_bugs.test.ts --hideSkippedTests --testNamePattern 'SoA simple getter|SoA property read from any-annotated|SoA method dispatch from any-annotated'`: pass.
  - `git diff --check`: pass.
  - Bounded mahjong core run with `UDON_FAST_METADATA_PASS=1
    UDON_LIGHTWEIGHT_TRY=1 UDON_ALLOW_OUTLINE_PARAM_FIELDS=1
    UDON_SKIP_OUTLINE_METADATA_PASS=1 UDON_OUTLINE_MAX_CANDIDATES=64
    NODE_OPTIONS=--max-old-space-size=12288`: pass for 2 entries.
- Residual blocker:
  - Generated TASM is still extremely large (about 1.04 GiB for the two core
    entries). The current work makes the bounded run complete, but further UASM
    size reduction is still needed before this is practical for normal use.

# Udon-ish TAC Interpreter / TS IR Backend Tasks

## Task_1: Backend Design Skeleton

- type: design
- owns:
  - `src/transpiler/ir/**`
  - `src/transpiler/ts_ir/**`
  - `tests/unit/transpiler/**`
- depends_on: []

Acceptance:

- Define the public API for converting TAC to TS IR.
- Confirm switch-based `pc` execution as the initial generated form.
- Preserve TAC instruction index, label names, and optional source hints in generated output.
- Keep the TS IR backend parallel to the existing UASM backend.

Validation:

- required: true
- owner: orchestrator
- kind: review
- detail: Confirm API shape does not change existing UASM backend behavior.

- required: true
- owner: worker
- kind: unit
- detail: A minimal TAC program emits deterministic TS IR text.

## Task_2: Runtime Shim

- type: impl
- owns:
  - `src/transpiler/ts_ir/runtime/**`
  - `tests/unit/transpiler/ts_ir_runtime*.test.ts`
- depends_on:
  - Task_1

Acceptance:

- Implement `UdonVMRuntimeError` with PC, instruction, and extern context.
- Implement Udon-ish `DataList`, `DataDictionary`, and `DataToken` helpers.
- Implement selected numeric cast, boolean coercion, null comparison, and object equality helpers.
- Ensure null reference operations fail loudly rather than silently defaulting.
- Ensure unknown externs fail with actionable diagnostics.

Validation:

- required: true
- owner: worker
- kind: unit
- detail: `DataList.Count` on null throws `UdonVMRuntimeError` with context.

- required: true
- owner: worker
- kind: unit
- detail: DataToken null and typed unwrap behavior is covered.

## Task_3: TS IR Emitter

- type: impl
- owns:
  - `src/transpiler/ts_ir/**`
  - `tests/unit/transpiler/ts_ir_emit*.test.ts`
- depends_on:
  - Task_1
  - Task_2

Acceptance:

- Emit `Assignment`, `Copy`, `BinaryOp`, `Label`, `ConditionalJump`, and `UnconditionalJump`.
- Emit selected `Call`, `MethodCall`, `PropertyGet`, and `PropertySet` operations for DataList/DataDictionary/DataToken.
- Generate heap slot declarations with concrete, nullable, or `unknown` types instead of `any`.
- Generate executable TypeScript that preserves TAC step order and visible heap mutations.
- Fail clearly for unsupported TAC instruction kinds.

Validation:

- required: true
- owner: worker
- kind: unit
- detail: Small TAC fixtures execute successfully in Node.js.

- required: true
- owner: worker
- kind: typecheck
- detail: Generated TS IR typechecks under the TS IR strict config.

## Task_4: CLI and Test Harness

- type: impl
- owns:
  - `src/cli/**`
  - `tests/vm/**`
  - `package.json`
  - `tsconfig*.json`
- depends_on:
  - Task_2
  - Task_3

Acceptance:

- Add a command path for emitting TS IR artifacts.
- Add a command path for typechecking generated TS IR artifacts.
- Add a command path for running generated TS IR artifacts in Node.js.
- Keep generated files isolated from normal source builds unless explicitly requested.
- Allow the TS IR semantic path to run before Unity VM validation.

Validation:

- required: true
- owner: worker
- kind: command
- detail: `pnpm build`

- required: true
- owner: worker
- kind: command
- detail: `pnpm test:ts-ir`

## Task_5: Focused Regression Fixtures

- type: test
- owns:
  - `tests/unit/transpiler/**`
  - `tests/vm/**`
- depends_on:
  - Task_2
  - Task_3
  - Task_4

Acceptance:

- Add a fixture that reproduces null `DataList.Count` at the TS IR layer.
- Add a fixture that makes untracked handle dispatch failures observable.
- Add a fixture for structural union `isWin` dispatch safety.
- Ensure failure output reports TAC instruction context and generated TS location where available.

Validation:

- required: true
- owner: worker
- kind: unit
- detail: Regression fixtures pass or fail according to expected semantics.

- required: true
- owner: reviewer
- kind: review
- detail: Confirm Node-side failures correspond to previously observed Unity VM failure modes.

## Task Waves

Wave 1:

- Task_1

Wave 2:

- Task_2
- Task_3

Wave 3:

- Task_4

Wave 4:

- Task_5

## Progress Log

- Not started.

## Decision Log

- Initial decision: implement a Udon-ish TAC interpreter / TS IR backend instead of TAC-to-TypeScript-AST round trip.
- Initial decision: use switch-based `pc` execution for stable TAC correspondence and VM-like diagnostics.
- Initial decision: keep TS IR as a parallel validation backend, not a replacement for UASM/Unity VM.

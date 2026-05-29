# Inline Instance Outline Plan

## Scope

Evaluate and, if feasible, implement transpiler-side sharing for repeated inline instance method expansion to reduce TAC explosion in `../mahjong-t2` without changing public APIs.

Repository rule context: `docs/coding-agent/rules/index.md` is not present/readable, so validation is selected from the project's existing build/test commands and the AGENTS guidance.

Research waived: subagent dispatch is not available unless the user explicitly asks for delegation; the Orchestrator will inspect locally and record evidence.

## Task_1

type: research
owns:
- `src/transpiler/ir/ast_to_tac/**` (read-only)
- `tests/unit/transpiler/**` (read-only)
- `../mahjong-t2/src/**` (read-only)
depends_on: []
acceptance:
- Map the current inline static/instance outline mechanisms and their eligibility limits.
- Identify the smallest correct design for sharing repeated inline instance bodies or inline-class returns.
- Record correctness risks around receiver state, return slots, field prefixes, and side effects.
validation:
- kind: code-inspection
  required: true
  owner: orchestrator
  detail: Inspect relevant converter/call/inline helper code and summarize design constraints.

## Task_2

type: impl
owns:
- `src/transpiler/ir/ast_to_tac/**`
- `tests/unit/transpiler/**`
depends_on:
- Task_1
acceptance:
- Implement only the narrowest optimization that has a clear correctness argument.
- Preserve existing behavior for unsupported outline cases by falling back to current inlining.
- Add or adjust focused tests if the implementation changes outline eligibility or emitted behavior.
validation:
- kind: tests
  required: true
  owner: orchestrator
  detail: Run targeted Vitest tests and `pnpm build`; run `../mahjong-t2` transpile/profile if the implementation is expected to affect it.

## Task_3

type: review
owns:
- `src/transpiler/ir/ast_to_tac/**` (read-only)
- `tests/unit/transpiler/**` (read-only)
depends_on:
- Task_2
acceptance:
- Review the patch for behavior drift, aliasing bugs, and hidden hot-path regressions.
- Confirm validation evidence is sufficient or document remaining blockers.
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

- 2026-05-29: Plan created for transpiler-side inline instance outlining investigation.
- 2026-05-29: Existing outline keys include the concrete inline instance prefix for instance methods, so equivalent method bodies on different receiver prefixes are counted and emitted separately.
- 2026-05-29: Implemented an opt-in shared receiver outline path behind `UDON_SHARED_INSTANCE_OUTLINE=1`. The shared body uses a synthetic receiver prefix; each call site copies receiver fields into that prefix before the jump and copies them back after return.
- 2026-05-29: A focused test now verifies that calls to the same mutating instance method across two receiver prefixes produce one outlined body and preserve per-receiver fields through copy-in/copy-out.
- 2026-05-29: `../mahjong-t2` profiling improved metadata pass from about 3.0M emitted instructions / 5.9s to about 1.93M / 3.5s with `UDON_FAST_METADATA_PASS=1 UDON_SHARED_INSTANCE_OUTLINE=1`, but pass2 still did not complete within the 120-180s timeout window.
- 2026-05-29: Tested a prototype for inline-class return outlining; it was not retained because it did not make `../mahjong-t2` complete and shallow cloning would be semantically unsafe for reference fields such as Maps.

## Decision Log

- 2026-05-29: Proceeding without subagents due to tool policy; recorded as a harness waiver.
- 2026-05-29: Keep shared receiver outlining opt-in rather than default-on until broader validation covers aliasing and receiver-field side effects.
- 2026-05-29: Do not retain inline-class return outlining in this patch; it requires a deeper object-clone/shareability design.

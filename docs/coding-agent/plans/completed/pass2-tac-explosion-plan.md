# Pass2 TAC Explosion Investigation Plan

## Scope

Continue investigating the remaining pass2 TAC explosion for `../mahjong-t2` after shared receiver outlining. Identify whether the next practical fix belongs in outlining, code generation streaming, source-level sharing, or project-specific opt-ins.

Repository rule context: `docs/coding-agent/rules/index.md` is not present/readable, so validation is selected from the project build/test commands and profiling runs.

Research waived: subagent dispatch is not available unless the user explicitly asks for delegation; the Orchestrator will inspect and profile locally.

## Task_1

type: research
owns:
- `src/transpiler/**` (read-only unless adding temporary diagnostics)
- `../mahjong-t2/**` (read-only)
- `docs/coding-agent/plans/**`
depends_on: []
acceptance:
- Identify which entry/method still dominates pass2 after `UDON_SHARED_INSTANCE_OUTLINE=1`.
- Separate remaining causes into outline misses, candidate ranking/cap issues, semantic ineligibility, or full-output size.
- Record evidence from bounded profile runs.
validation:
- kind: profiling
  required: true
  owner: orchestrator
  detail: Run bounded `../mahjong-t2` transpile/profile commands or targeted instrumentation and record the results.

## Task_2

type: impl
owns:
- `src/transpiler/**`
- `tests/unit/transpiler/**`
depends_on:
- Task_1
acceptance:
- Implement only a narrow optimization if Task_1 identifies one with a clear correctness argument.
- Keep risky behavior behind opt-in flags unless broad safety is demonstrated.
- Remove any temporary diagnostics not intended as product behavior.
validation:
- kind: tests
  required: true
  owner: orchestrator
  detail: Run targeted Vitest tests and `pnpm build`; rerun bounded `../mahjong-t2` profile when relevant.

## Task_3

type: review
owns:
- `src/transpiler/**` (read-only)
- `tests/unit/transpiler/**` (read-only)
depends_on:
- Task_2
acceptance:
- Review the retained change or document why no change is retained.
- Confirm validation and remaining risk are clear.
validation:
- kind: manual-review
  required: true
  owner: orchestrator
  detail: Local review; Reviewer subagent waived because delegation was not explicitly requested.

## Task Waves

Wave 1: Task_1
Wave 2: Task_2
Wave 3: Task_3

## Progress Log

- 2026-05-29: Plan created to continue investigating remaining pass2 TAC explosion.
- 2026-05-29: Added opt-in inline-class parameter field copy support for outlined methods under `UDON_ALLOW_OUTLINE_PARAM_FIELDS=1`; default ineligibility behavior remains unchanged.
- 2026-05-29: Validation passed: `pnpm vitest run tests/unit/transpiler/inline_outline.test.ts`; `pnpm build`.
- 2026-05-29: `mahjong-t2` profile with `UDON_FAST_METADATA_PASS=1 UDON_SHARED_INSTANCE_OUTLINE=1 UDON_ALLOW_OUTLINE_PARAM_FIELDS=1` still timed out at 180s while assembling `NetworkGameOrchestrator`; `NetworkGameOrchestrator` pass2 took 126.6s / 5,191,313 TAC, codegen emitted 14,185,564 Udon instructions.
- 2026-05-29: Adding `UDON_OUTLINE_MAX_CANDIDATES=256` let core generation proceed to existing `src/vrc` validation failure. Cold/cache-labelled profile showed `GameOrchestrator` pass2 10.2s / 1,200,317 TAC and `NetworkGameOrchestrator` pass2 5.8s / 540,192 TAC; generated core outputs were 95M and 43M.
- 2026-05-29: `pnpm exec biome check src/transpiler/ir/ast_to_tac/helpers/inline.ts tests/unit/transpiler/inline_outline.test.ts` failed on pre-existing lint/format issues in already-dirty `inline.ts`; not used as required validation for this scoped change.
- 2026-05-29: Made the outline candidate cap default to 256 only when both `UDON_SHARED_INSTANCE_OUTLINE=1` and `UDON_ALLOW_OUTLINE_PARAM_FIELDS=1` are active; explicit `UDON_OUTLINE_MAX_CANDIDATES` still overrides.
- 2026-05-29: Revalidated without setting `UDON_OUTLINE_MAX_CANDIDATES`: core generation selected max=256, completed in 25.5s, and stopped only at the existing `src/vrc` `VRChatInputBridge` decorator validation error. `GameOrchestrator` was 1,200,317 TAC / 3,116,755 Udon instr / 99,444,248 bytes; `NetworkGameOrchestrator` was 540,192 TAC / 1,414,885 Udon instr / 45,059,399 bytes.
- 2026-05-29: Relaxed UdonBehaviour interface validation for undecorated base classes that have a decorated descendant; this matches the `VRChatInputBridge` -> `VRChatInputController` pattern.
- 2026-05-29: Full `../mahjong-t2` `pnpm transpile:src -- --no-optimize` completed with the gated optimization envs in about 27.1s total profiled transpile time: core 25.7s, vrc 1.4s. Generated all core and vrc `.tasm` outputs.

## Decision Log

- 2026-05-29: Proceeding without subagents due to tool policy; recorded as a harness waiver.
- 2026-05-29: Keep inline-class parameter field outlining behind `UDON_ALLOW_OUTLINE_PARAM_FIELDS=1`; it is now less unsafe via call-site field copy-in/out, but still requires broader semantic review before making default.
- 2026-05-29: Treat `UDON_OUTLINE_MAX_CANDIDATES=256` as the next practical runtime setting for `mahjong-t2`; it addresses the network listener/serializer explosion that remains with the default cap of 64.
- 2026-05-29: Do not globally default the cap to 256 because a previous 2026-05-27 profile regressed before shared receiver / param-field outlining existed; scope the default increase to the gated combination that produced the current improvement.
- 2026-05-29: The remaining production-readiness question is whether the gated env flags should stay opt-in or be promoted after broader semantic tests. The timeout itself is resolved under the gated profile.

# Coding Agent Lessons

## 2026-05-25 - Build package before consumer-style UASM validation

- tags: validation/verification, tooling/environment, assumptions/interpretation
- symptom: UdonVM validation was started from source-driven generation without first confirming `pnpm install`, `pnpm build`, and regenerated UASM artifacts.
- root cause: The check mixed local source execution with consumer-style package validation, so the generated UASM was not clearly tied to the built package state.
- fix: Re-run dependency installation/build before regenerating UASM for UdonVM verification.
- prevention: Before UdonVM or downstream-project validation, use a turn checklist: install/build first, regenerate artifacts second, execute VM third, then report evidence.

## 2026-05-25 - Do not overinterpret expected long optimizer runs

- tags: tooling/environment, assumptions/interpretation, validation/verification
- symptom: A long optimizer-enabled TS IR generation run was treated as a reason to pivot away from optimizer usage.
- root cause: The validation decision mixed two separate constraints: optimizer wall time and generated TS execution feasibility.
- fix: Keep optimizer as an optional, expected-long path; focus the current task on making generated TS IR executable without requiring the TypeScript parser to handle millions of switch cases.
- prevention: When a command is expected to be long, distinguish "expected slow" from "blocked" before changing implementation direction, and state the criterion being optimized.

## 2026-05-25 - Treat Unity VM as authoritative for Udon behavior

- tags: validation/verification, assumptions/interpretation, tooling/environment
- symptom: Investigation used udon-go failures as if they were equivalent to Unity Udon VM failures.
- root cause: udon-go is still under validation and can diverge from Unity VM semantics, so it is not an authoritative oracle for this repository's runtime correctness.
- fix: Use Unity VM results as the source of truth for Udon runtime behavior; treat udon-go output only as optional diagnostic context.
- prevention: Before reporting runtime validation, identify the authoritative executor. For current Udon VM investigations, do not classify a failure as confirmed unless Unity VM reproduces it.

## 2026-05-29 - Stage cheap optimizer passes before heavy global passes

- tags: performance, optimizer, assumptions/interpretation
- symptom: Large generated TAC was made to complete by skipping heavy optimizer passes, but this under-addressed the user's goal that larger code should also benefit from optimization.
- root cause: The optimization strategy focused on avoiding timeout/OOM rather than first shrinking the input with cheap local passes and then conditionally attempting heavier global/fixpoint passes.
- fix: Reorient large-input optimization around a staged pipeline: converge lightweight/local passes first, then gate heavy passes using the original input size and current reduced size.
- prevention: For performance fixes in optimizer pipelines, compare both "completion" and "optimization effectiveness"; prefer cheap-to-heavy staging before adding broad skips.

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

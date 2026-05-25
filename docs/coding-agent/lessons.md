# Coding Agent Lessons

## 2026-05-25 - Do not overinterpret expected long optimizer runs

- tags: tooling/environment, assumptions/interpretation, validation/verification
- symptom: A long optimizer-enabled TS IR generation run was treated as a reason to pivot away from optimizer usage.
- root cause: The validation decision mixed two separate constraints: optimizer wall time and generated TS execution feasibility.
- fix: Keep optimizer as an optional, expected-long path; focus the current task on making generated TS IR executable without requiring the TypeScript parser to handle millions of switch cases.
- prevention: When a command is expected to be long, distinguish "expected slow" from "blocked" before changing implementation direction, and state the criterion being optimized.

---
created: 2026-05-07T02:40:02+09:00
updated: 2026-05-07T02:40:02+09:00
status: open
severity: medium
component: stubs
related_branch: feat/number-double-mapping
related_plan: ~/.claude/plans/drifting-conjuring-walrus.md (§ Phase C)
---

# Migrate stub `number` to `bigint` for parameters / returns that are int in C#

## Summary

After `feat/number-double-mapping` lands, TypeScript `number` is Udon Double.
Several stubs declare `number` for callbacks / API surfaces that are `int` on
the C# side (MIDI parameters, frame delays, type IDs, indexers). Each call
now incurs a needless Double→Int32 SystemConvert at the EXTERN boundary,
and the type meaning is misleading to users.

The plan agreed during PR design was: replace those `number` declarations
with `bigint` (which maps to Int64 today and will be the future home of
branded `UdonInt`/`UdonLong`/`UdonUInt`/`UdonULong` subtypes).

## Locations to migrate (~8 confirmed)

### `src/stubs/UdonSharpBehaviour.ts`

| Line | Member | Today | Target |
|---|---|---|---|
| 54 | `SendCustomEventDelayedFrames(_eventName: string, _delayFrames: number)` | `number` | `bigint` (overload, keep `number` overload for back-compat) |
| 68, 72 | `GetUdonTypeID(): number` / generic | `number` | `bigint` (return-type breaking; coordinate with TypeID emitter, see below) |
| 147–149 | `MidiNoteOn/Off/ControlChange(_channel, _number, _velocity: number)` | `number` | `bigint` (overload set) |

### `src/stubs/DataContainerTypes.ts`

| Line | Member | Today | Target |
|---|---|---|---|
| 13 | `[index: number]: DataToken` | `number` | `[index: number \| bigint]: DataToken` (union signature — `[index: number]` and `[index: bigint]` cannot coexist on the same interface) |
| 55 | `TokenType!: number` | `number` | `bigint` (breaking; consumer code comparing against `=== TokenType.Int` etc. needs `=== Int<n>`) |

### `src/stubs/VRChatTypes.ts`

| Line | Member | Today | Target |
|---|---|---|---|
| 231 | `GetServerTimeInMilliseconds(): number` | `number` | `bigint` (semantically a long anyway) |

### Stays as `number` (= Double) — verified correct

`InputMove*` / `InputLook*` (-1.0..1.0), `_delaySeconds`,
`_prevEyeHeightAsMeters`, Vector*.x/y/z, Color channels (0..1), Math
return values — all genuinely floating-point.

## Required pre-work for `GetUdonTypeID` migration

Changing the return type of `GetUdonTypeID` to `bigint` breaks any user code
that does `=== <numeric-literal>` comparisons. Before flipping, grep the
TypeID emitter side and align:

```bash
git grep -n "UdonTypeID\|GetUdonTypeID\|__udonTypeId\|udonTypeId"
```

Likely emit sites: `src/stubs/UdonDecorators.ts` (`@UdonBehaviour` decorator),
`src/transpiler/frontend/class_registry.ts` (type ID assignment), reflection
metadata path (`reflect: true`).

## Required pre-work for `[index: number | bigint]` indexer

Confirm with a minimal test that TypeScript actually accepts a union index
signature in this position — historically `[index: number]: T` and
`[index: bigint]: T` cannot coexist on the same interface. If union doesn't
work, fall back to keeping `number` only for the indexer and document
that callers must pass through `Number(bigintValue)`.

## Out-of-scope (future phase)

Introducing branded subtypes of `bigint` (`UdonInt extends bigint`,
`UdonUInt extends bigint`, etc.) is the cleaner end state but a separate,
larger refactor. This issue only tracks the bare-`number` → `bigint`
migration that is safe to land standalone.

## References

- Plan file: `~/.claude/plans/drifting-conjuring-walrus.md` (§ Phase C)
- Baseline branch: `feat/number-double-mapping`

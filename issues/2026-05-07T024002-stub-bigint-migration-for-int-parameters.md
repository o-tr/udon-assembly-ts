---
created: 2026-05-07T02:40:02+09:00
updated: 2026-05-07T18:30:00+09:00
status: resolved
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

## Locations migrated

### `src/stubs/UdonSharpBehaviour.ts` — ✅ Migrated (no overloads)

| Line | Member | Before | After |
|---|---|---|---|
| 54 | `SendCustomEventDelayedFrames(_eventName: string, _delayFrames: bigint)` | `number` | `bigint` |
| 68, 72 | `GetUdonTypeID(): UdonLong` / generic | `number` | `UdonLong`, returns `0n as UdonLong` |
| 147–149 | `MidiNoteOn/Off/ControlChange(_channel, _number, _velocity: bigint)` | `number` | `bigint` |

### `src/stubs/DataContainerTypes.ts` — No changes needed

TypeScript limitations prevent union index signatures (`[index: number]` and
`[index: bigint]` cannot coexist on the same interface). The indexer remains
`[index: number]`. Consumer code comparing against `TokenType.Int` etc. should
use branded types when available.

### `src/stubs/VRChatTypes.ts` — ✅ Migrated

| Line | Member | Before | After |
|---|---|---|---|
| 231 | `GetServerTimeInMilliseconds(): UdonLong` | `number` | `UdonLong`, uses `BigInt(Date.now()) as UdonLong` |

### Stays as `number` (= Double) — verified correct

`InputMove*` / `InputLook*` (-1.0..1.0), `_delaySeconds`,
`_prevEyeHeightAsMeters`, Vector*.x/y/z, Color channels (0..1), Math
return values — all genuinely floating-point.

## Key decisions

- **No overloads**: MIDI parameters and `SendCustomEventDelayedFrames` are replaced directly with `bigint`. No backward-compat overload sets were needed per user feedback on C# int signatures.
- **DataContainerTypes indexer**: Union index signature `[index: number \| bigint]` is not supported by TypeScript for this interface position. Indexer remains `number`; consumers should use branded types when available.

## Out-of-scope (future phase)

Introducing branded subtypes of `bigint` (`UdonInt extends bigint`,
`UdonUInt extends bigint`, etc.) is the cleaner end state but a separate,
larger refactor. This issue only tracks the bare-`number` → `bigint`
migration that is safe to land standalone.

## References

- Baseline branch: `feat/number-double-mapping`

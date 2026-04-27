# Step 10 D/C leak — sample findings

Data captured on `feat/step10-metrics-sample-metadata` against
`../mahjong-t2/src/{vrc,cli,core/domain}`. Output:
`/tmp/step10-d-c/{vrc,core_domain}.json` (cli produced no step-10 hits).

## Summary

| Subset | totalHits | uniqueTypes | union | simple-name |
| ------ | --------- | ----------- | ----- | ----------- |
| vrc | 9 | 7 | 4 | 5 |
| cli | 0 | 0 | 0 | 0 |
| core/domain | 6 | 6 | 5 | 1 |

After Step A+B (PR #191), only the targeted residual buckets remain.
The captured samples show **D and C share a single root cause**.

## Step D — heterogeneous unions

`WinResult | null` sample (vrc):

```
typeFlags: "Union"
aliasName: null
unionMemberFlags: ["Null", "Object", "Object"]
```

The alias `WinResult` is *already flattened* by TypeScript before
step 1 sees it. Top-level union has **3** constituents (the 2 variants
of WinResult plus null). `removeNullishUnionMembers` strips `Null`,
leaving 2 Object members that resolve to different `TypeSymbol`s →
returns null. Step 5 also can't collapse for the same reason. Falls
through to step 10. Hypothesis #1 (alias bypass) is **refuted** —
the type carries the `Union` flag at the top level. The leak is purely
"step 5 has no collapse rule for heterogeneous unions."

Other `union` entries (`0 | UdonInt`, `Meld | { ... }`,
`PlayerState | PlayerStateInit`, `{type:"ron"...} | {type:"tsumo"...}`)
exhibit the same shape: `typeFlags: "Union"`, members of mixed kinds.

## Step C — simple-name leaks

`WinResult` (project-class simple-name) sample (vrc & core/domain):

```
typeFlags: "Union"
aliasName: "WinResult"
aliasTargetFlags: "Union"
hasSymbol: false
unionMemberFlags: ["Object", "Object"]
```

The leaked "simple name" *is itself a union type alias*. Resolution
trace:
- Step 5 enters (Union flag) but the 2 variants don't resolve to the
  same symbol → falls through.
- Step 7's `getSymbol() ?? aliasSymbol` returns the alias symbol.
  `SymbolFlags.TypeAlias` → step 7e fires.
- `getDeclaredTypeOfSymbol(aliasSymbol)` returns the same `ts.Type`
  instance, so `aliasType !== type` is false → step 7e bails.
- Step 7f's name-based `lookupBuiltinByName` / `getAlias` misses.
- Step 8 doesn't fire (no `Object` flag).
- Steps 9/9a/9b don't fire.
- Falls to step 10 with `typeText = "WinResult"` (alias name preserved
  by `typeToString`).

`NetworkEvent` and `SyncMeld` follow the same pattern (5- and 3-variant
discriminated unions respectively).

The original C hypothesis (TS strips symbol during generic-parameter
substitution and leaves a `TypeReference`) is **refuted** for these
samples — `targetSymbolName` is `null` and `objectFlags` is unset
because the type isn't an `Object` at all; it's a `Union`.

## Recommended fix

A single line at the end of step 5 in
`src/transpiler/frontend/type_checker_type_resolver.ts:184-203` drains
both buckets:

```ts
if (type.flags & ts.TypeFlags.Union) {
  const union = type as ts.UnionType;
  const memberTypes = union.types.map((t) => this.resolveFromTsType(t));
  if (memberTypes.length > 0 && memberTypes.every((t) => t === memberTypes[0])) {
    return memberTypes[0];
  }
  if (union.types.every((t) => t.flags & ts.TypeFlags.StringLike)) {
    return PrimitiveTypes.string;
  }
  if (union.types.every((t) => t.flags & ts.TypeFlags.BooleanLike)) {
    return PrimitiveTypes.boolean;
  }
  return ObjectType;  // ← new: heterogeneous union → ObjectType
}
```

This handles:
- D entries: heterogeneous unions of any kind (`X | Y`, `X | null`
  post-strip-failure, `0 | UdonInt`, etc.).
- C entries: simple-name leaks that are aliased Unions, because they
  hit step 5 *before* step 7's alias path. The aliased-Union case is
  caught here and never reaches 7e/7f.

Trade-off: `0 | UdonInt` would map to `ObjectType` rather than `int32`.
This matches the original analysis's recommendation
("For Udon these have no native representation; collapse to ObjectType
is correct"). The literal `0` member already resolves to `single` (not
`int32`), so the union-of-mismatched-types semantics force a widening
either way.

## What this means for the PR sequence

The originally-planned **separate** D and C fix PRs collapse into one,
since they share the same fix. After this single line lands:
- All current step-10 hits on mahjong-t2 (vrc + cli + core/domain)
  drain to zero.
- The `typeToString` fallback at lines 396-423 becomes dead code on
  this fixture.
- The **Final cleanup PR** (remove the step-10 fallback + delete the
  metrics module) becomes the immediate next step, contingent on a
  full `core/` (144-file) run completing within the budget — which the
  original analysis flagged as timing out at 25min, so that needs
  re-checking with the new fix in place.

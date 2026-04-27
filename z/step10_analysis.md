# Step 10 reach measurement (mahjong-t2)

Run via `UDON_TS_STEP10_METRICS=1 ... pnpm tsx src/cli/index.ts -i <subdir>`. The
core directory (144 files) does not finish within reasonable wall-clock under
metrics mode; results below cover three subsets — `cli/` (6 files), `vrc/` (21),
`core/domain/` (88) — totalling **115 files of 171, ~67% coverage**. Numbers
quoted are from those three samples only.

## Aggregate by category

| Category       | cli   | vrc    | core/domain | Notes                                                                |
| -------------- | ----- | ------ | ----------- | -------------------------------------------------------------------- |
| function       | 12922 | ~17572 | 5584        | `(value, index) => U`, `PromiseLike<T>` callbacks, Map/Set/Array.forEach |
| simple-name    | 3     | 11     | 5           | `WinResult`, `NetworkEvent`, `SyncMeld`, `any`, `unknown`, `never`   |
| union          | 0     | 6      | 4           | `WinResult \| null`, `0 \| UdonInt`, `PlayerState \| PlayerStateInit` |
| anon-object    | 0     | 0      | 1           | `{ type: "ron"; ron: UdonInt } \| { type: "tsumo"; ... }`            |
| promise        | 0     | 0      | 0           | (currently bucketed inside function due to `=>`)                     |
| tuple          | 0     | 0      | 0           | tuple-as-param shows up inside function arguments                    |
| **total hits** | 12926 | 17603  | 5595        |                                                                      |

The function bucket accounts for **>98%** of all step-10 hits across the three
samples. Without addressing it, no other promotion has measurable impact.

## Top types observed

1. `(value: U, index: number) => U` — Array.map / Array.reduce callback type
   with unresolved generic parameters. Single dominant entry; appears
   thousands of times because `array.map()` is called from many sites and
   the type checker stamps the same generic shape each time.
2. `(reason: any) => TResult2 | PromiseLike<TResult2>` /
   `(value: TResult1 | TResult2) => TResult1 | PromiseLike<TResult1>` —
   `Promise.then` callback signatures.
3. `(value: T, key: K, map: Map<K, V>) => void` — Map.forEach signature.
4. `(value: T, value2: T, set: Set<T>) => void` — Set.forEach signature.

All of these are callable anonymous types: TypeScript represents them as
`ObjectType` with `ObjectFlags.Anonymous` and at least one Call signature.
Step 8's anonymous-object branch only triggers when `getPropertiesOfType()`
returns one or more entries; function types have zero properties (the call
signature is held separately), so they fall through into the typeToString
fallback at step 10.

## Promotion plan

### Step A — function types (closes ~98% of hits)

Add a branch ahead of step 10 (and ahead of step 8's mapped-type handling so
it doesn't matter where exactly) that returns `ObjectType` when:

```ts
type.flags & ts.TypeFlags.Object &&
this.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0
```

Function types in Udon are not first-class — there is no value to materialize.
`ObjectType` is the right collapse. Place this either inside step 8 (extend
the anonymous-object branch) or as a new step 8c so callable interfaces
(rare; e.g. `interface F { (x: number): string }`) don't double-handle.

### Step B — simple-name leaks (TS keywords)

`any` / `unknown` / `never` reach step 10 because they have no symbol yet pass
through every flag check. Currently step 4 covers `BooleanLike`, `NumberLike`,
`StringLike`, `BigIntLike`, `Void`. The TS flags for `any` and `unknown` are
`TypeFlags.Any` / `TypeFlags.Unknown`; `never` is `TypeFlags.Never`.

Add a step ~4c:
```ts
if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) {
  return ObjectType;
}
```

### Step C — simple-name leaks (project classes)

`WinResult`, `NetworkEvent`, `SyncMeld` reach step 10 even though they are
ordinary project classes/interfaces. Hypothesis: these are referenced via
some path that yields a `ts.Type` whose `getSymbol() ?? aliasSymbol` is
empty. Likely origin: `type` flowing in from a generic-parameter substitution
where TS strips the symbol, e.g. `Array<WinResult>` → element type is
`WinResult` but with no symbol. Needs investigation — read the actual TS
type instance at one of these hits before designing the fix. The metrics
collector currently records only the type text; capturing
`type.flags`/`objectFlags`/`!!type.getSymbol()` per first occurrence would
disambiguate.

### Step D — unions and intersections

Step 5 already collapses unions whose members all resolve to the same symbol.
The remaining union hits (`WinResult | null`, `0 | UdonInt`, `PlayerState |
PlayerStateInit`) are heterogeneous unions that don't satisfy that
condition. For Udon these have no native representation; collapse to
`ObjectType` is correct. Add at the end of step 5 (after the same-symbol /
StringLike / BooleanLike branches):
```ts
return ObjectType;
```

**TODO before applying D**: `WinResult | null` reaching step 10 contradicts
step 1's `removeNullishUnionMembers`, which is supposed to strip `null` from
unions before recursing. One of these is true:
1. `WinResult` is a type alias whose *declared* type already contains `| null`,
   and the alias-symbol path in step 7e bypasses step 1's nullish strip.
2. The `null` member type doesn't have `TypeFlags.Null` set in this case
   (e.g. it's a literal type with a different flag combination).
3. The `WinResult | null` ts.Type is not a union at the top level (e.g. it's
   wrapped in a Conditional or IndexedAccess that resolves to a union after
   the early returns).

Before committing the Step D collapse, instrument the record point: when
`typeText.includes(" | null")` or `" | undefined"`, log `type.flags`,
`type.aliasSymbol?.name`, and `(type as ts.UnionType).types?.map(t => t.flags)`.
One sample disambiguates which of the three above is the leak path; the fix
may belong earlier than step 5.

### Step E — anonymous discriminated objects

`{ type: "ron"; ... } | { type: "tsumo"; ... }` is one hit total. Once step D
collapses heterogeneous unions, this falls into D and needs no separate
treatment.

## Order to apply

1. **A** first (98%+ of traffic). Verify the metrics file shows the function
   bucket drained on a re-run.
2. **B** (cheap, TS keyword leaks).
3. **D** (heterogeneous unions).
4. **C** last — needs an investigation step to capture flags + a single
   sample's symbol info before the fix. After A/B/D land, the simple-name
   bucket should be small enough that the remaining cases are tractable.

After A+B+D are merged, re-run the measurement; if Step 10 hits drop to a
small number under the simple-name bucket and stay actionable, a follow-up
PR can finally remove the typeToString fallback.

## Caveats

- `core/` (144 files) did not complete within 25min wall-clock. Whether this
  is metric-mode-induced overhead or pre-existing slow-path on this project
  is unknown. The samples are biased toward shapes that exist in cli/, vrc/,
  and core/domain/; if `core/services/` has different patterns, those won't
  show here.
- `(value: U, index: number) => U` appearing 5574+ times in domain alone
  suggests the same call site is resolved many times. Caching by
  `ts.Type` would already deduplicate, so the multiplicity probably comes
  from distinct `ts.Type` instances for the same textual signature
  (different `array.map` call sites). Worth a quick check on whether the
  type cache is doing anything for these — if yes, the count is
  unique-cache-misses; if no, it is a perf hotspot independent of step 10
  promotion.

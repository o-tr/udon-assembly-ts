# Udon-ish TAC Interpreter / TS IR Backend Requirements

## Purpose

Add a parallel verification backend that emits executable TypeScript from TAC and runs it on Node.js before UASM/Unity VM execution. The goal is to shorten debugging loops for runtime issues that are currently only visible inside the Unity VM.

This backend does not replace the existing UASM backend. It is a diagnostic and semantic validation path for TAC-level behavior.

## Goals

- Detect null or uninitialized heap-slot usage before Unity VM execution.
- Reproduce Udon-like runtime failures in Node.js with TAC instruction context.
- Validate DataList, DataDictionary, DataToken, inline handle, D3 dispatch, structural union, and SoA behavior at the TAC layer.
- Preserve a clear mapping from generated TypeScript execution back to TAC instruction index, labels, extern names, and eventually UASM PC.
- Keep generated TypeScript strict enough to expose type-erasure mistakes without turning every unknown slot into `any`.

## Non-Goals

- Do not implement a full TypeScript AST round trip from TAC.
- Do not emit idiomatic or reconstructed source TypeScript as the initial backend.
- Do not replace Unity VM validation.
- Do not model all VRChat/Udon APIs in the first milestone.
- Do not optimize generated TypeScript for readability or runtime speed before semantic coverage is useful.

## Architecture

The initial backend should emit a switch-based interpreter shape:

```ts
while (true) {
  switch (pc) {
    case 0:
      heap.t1 = externs.addInt(heap.a, heap.b, { pc: 0 });
      pc = 1;
      break;
    case 1:
      if (!heap.cond) pc = labels.done;
      else pc = 2;
      break;
  }
}
```

This keeps TAC-to-runtime correspondence stable and makes failures easier to map than a structured TypeScript reconstruction.

## Generated Artifact Shape

Generated files should be isolated from source code and disposable.

```txt
generated/ts-ir/
  runtime/
    index.ts
  cases/
    <case-name>.ir.ts
    <case-name>.test.ts
```

The exact output directory can change, but generated artifacts must not be required for normal package builds unless explicitly requested by a TS IR command.

## Runtime Model

The runtime shim must model Udon-ish behavior rather than JavaScript convenience behavior.

Required primitives:

- `UdonVMRuntimeError`
- `DataList<T>`
- `DataDictionary<K, V>`
- `DataToken<T>`
- integer/float cast helpers
- boolean coercion helpers matching TAC/Udon expectations
- object equality and null comparison helpers
- extern dispatcher or typed extern table
- heap-slot read/write helpers where useful
- debug log capture for `Debug.Log` and `Debug.LogError`

Null references must fail loudly. For example, `DataList.Count` on null should throw an `UdonVMRuntimeError`, not return `0` or silently create a list.

Errors should carry enough context for investigation:

```ts
class UdonVMRuntimeError extends Error {
  constructor(
    message: string,
    readonly pc?: number,
    readonly instruction?: string,
    readonly extern?: string,
  ) {
    super(message);
  }
}
```

## Type Model

Generated TypeScript should avoid `any`. Unknown values should remain `unknown` until explicitly unwrapped or coerced.

Minimum type model:

```ts
type UdonInt = number & { readonly __udon: "Int32" };
type UdonBool = boolean & { readonly __udon: "Boolean" };
type UdonString = string & { readonly __udon: "String" };

type Handle<T> = number & { readonly __handle: T };
type NullHandle = 0 & { readonly __nullHandle: true };
type MaybeHandle<T> = Handle<T> | NullHandle;

type DataToken<T = unknown> = {
  readonly __kind: "DataToken";
  readonly value: T;
};
```

Heap slots should be represented explicitly:

```ts
type Heap = {
  hand: MaybeHandle<Hand>;
  __inst_Hand_290__handle: MaybeHandle<Hand>;
  __inst_Hand_290__tiles: DataList<Tile> | null;
  __uninst_prop_11450: DataList<Tile> | null;
};
```

If exact slot type information is unavailable, prefer `unknown` plus an explicit runtime guard over `any`.

## TAC Coverage: First Milestone

The first implementation should cover only the TAC needed for focused semantic tests:

- assignment
- copy
- binary operations
- conditional jump
- unconditional jump
- labels
- extern calls
- method calls for selected DataList/DataDictionary/DataToken APIs
- property get/set for selected Udon-ish properties
- primitive casts

Unsupported TAC instructions should fail with a clear unsupported-instruction error that includes the instruction kind and index.

## Extern Requirements

Extern handling should use a typed table or generated typed calls rather than unvalidated string dispatch wherever possible.

```ts
const externs = {
  "VRCSDK3DataDataList.__get_Count__SystemInt32": countDataList,
  "VRCSDK3DataDataList.__GetValue__SystemInt32__VRCSDK3DataDataToken": getDataListItem,
} as const;
```

Unknown externs must fail immediately with context.

## Inline Class, D3 Dispatch, Structural Union, and SoA Requirements

Inline classes should initially stay close to their Udon representation:

- inline instance identity is a handle
- null/uninitialized identity is a null handle or sentinel
- fields live in heap slots or SoA field lists
- generated dispatch code should preserve null-handle guards

D3 dispatch should make guard behavior visible in generated TypeScript:

```ts
if (
  hand !== NULL_HANDLE &&
  instHand290.handle !== NULL_HANDLE &&
  hand === instHand290.handle
) {
  result = instHand290.tiles;
}
```

Structural union and SoA support can be incremental, but generated output must make missing candidate dispatch, uninitialized handles, and unsafe field reads observable.

## Commands

Add commands only after the core emitter/runtime can support them.

Target command shape:

```bash
pnpm emit:ts-ir
pnpm typecheck:ts-ir
pnpm test:ts-ir
```

Expected validation flow:

```txt
TS source -> AST -> TAC
TAC -> TS IR
tsc --noEmit for generated TS IR
Node execution for generated TS IR
UASM -> Unity VM
```

## TypeScript Configuration

Generated TS IR should have a strict tsconfig.

Required compiler options:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true
  }
}
```

## Acceptance Criteria

- A minimal TAC program can be emitted to TypeScript and executed in Node.js.
- Null `DataList.Count` produces a Node-side `UdonVMRuntimeError` with PC/instruction context.
- Unsupported externs and TAC instruction kinds fail with actionable diagnostics.
- Generated TypeScript typechecks under the TS IR strict config.
- A focused regression fixture can model at least one issue previously found only through Unity VM logs.

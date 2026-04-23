# udon-assembly-ts

TypeScript to Udon Assembly (.uasm) transpiler and UdonSharp-compatible TypeScript stubs.

## Features

- TypeScript -> TAC -> Udon Assembly pipeline
- Optional TAC optimization
- Batch transpilation for directories
- UdonSharp-compatible stubs for VRChat/Unity types

## Installation

```bash
pnpm add @ootr/udon-assembly-ts
```

## Library Usage

```ts
import { TypeScriptToUdonTranspiler } from "@ootr/udon-assembly-ts";

const transpiler = new TypeScriptToUdonTranspiler();
const result = transpiler.transpile(`
  let x: number = 10;
  let y: number = 20;
  if (x < y) {
    let z: number = x + y;
  }
`);

console.log(result.uasm);
console.log(result.tac);
```

### With Optimization

```ts
const result = transpiler.transpile(sourceCode, { optimize: true });
```

## CLI Usage

```bash
udon-assembly-ts -i src -o output/transpiler
```

Options:
- `-i`, `--input <dir>`: Input directory (repeatable)
- `-o`, `--output <dir>`: Output directory (default: `output/transpiler`)
- `-v`, `--verbose`: Verbose logging
- `--no-optimize`: Disable TAC optimization
- `--reflect`: Append reflection metadata to data section

## Stubs Usage

```ts
import { UdonTypeConverters } from "@ootr/udon-assembly-ts/stubs";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
```

## Project Structure

```
src/
├── transpiler/          # TypeScript parsing, IR, codegen
├── stubs/               # UdonSharp-compatible stubs
└── cli/                 # Batch transpiler CLI
```

## Docs

- [Native Array Spec](docs/native-array-spec.md)

## Breaking Changes

### v0.x.x — Type-checker hardening

- **Unknown types are now fatal.** `TypeMapper` no longer silently falls back to `object` for unrecognised TypeScript type names. It throws a `TranspileError` instead.
- **Batch errors propagate immediately.** `BatchTranspiler` no longer ignores per-file parse or dependency-resolution failures. Any error stops the batch immediately.

## Testing

```bash
pnpm test
```

## References

- https://github.com/vrchat-community/creator-docs
- https://github.com/MerlinVR/UdonSharp

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

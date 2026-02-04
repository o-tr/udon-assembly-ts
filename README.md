# udon-assembly-ts

TypeScript to Udon Assembly (.uasm) transpiler and UdonSharp-compatible TypeScript stubs.

## Features

- TypeScript -> TAC -> Udon Assembly pipeline
- Optional TAC optimization
- Batch transpilation for directories
- UdonSharp-compatible stubs for VRChat/Unity types

## Installation

```bash
pnpm add udon-assembly-ts
```

## Library Usage

```ts
import { TypeScriptToUdonTranspiler } from "udon-assembly-ts";

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
import { UdonTypeConverters } from "udon-assembly-ts/stubs";
import { UdonBehaviour } from "udon-assembly-ts/stubs/UdonDecorators";
```

## Project Structure

```
src/
├── transpiler/          # TypeScript parsing, IR, codegen
├── stubs/               # UdonSharp-compatible stubs
└── cli/                 # Batch transpiler CLI
```

## Testing

```bash
pnpm test
```

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

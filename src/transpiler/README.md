# TypeScript to Udon Assembly Transpiler

This module provides a complete transpiler pipeline that converts TypeScript code directly to Udon Assembly (.uasm) format, bypassing the need for UdonSharp.

## Architecture

The transpiler uses a three-phase architecture:

```
TypeScript Source
      ↓
[Frontend] Parse & Type Check
      ↓
Three-Address Code (TAC)
      ↓
[Optimizer] Constant Folding, Dead Code Elimination
      ↓
Udon Instructions
      ↓
[Assembler] Generate .uasm
      ↓
Udon Assembly (.uasm)
```

## Features

### Supported Language Features

- ✅ Variable declarations (`let`, `const`)
- ✅ Basic types (`number`, `boolean`, `string`)
- ✅ Binary operators (`+`, `-`, `*`, `/`, `<`, `>`, `<=`, `>=`, `==`, `!=`)
- ✅ Unary operators (`-`, `!`)
- ✅ Conditional statements (`if`/`else`)
- ✅ While loops
- ✅ Nested scopes

### Optimizations

- ✅ Constant folding (e.g., `5 + 3` → `8`)
- ✅ Dead code elimination
- ⚠️ Common subexpression elimination (skeleton only)

## Usage

### Basic Usage

```typescript
import { TypeScriptToUdonTranspiler } from './src/transpiler';

const transpiler = new TypeScriptToUdonTranspiler();
const result = transpiler.transpile(`
  let x: number = 10;
  let y: number = 20;
  if (x < y) {
    let z: number = x + y;
  }
`);

console.log(result.uasm); // Generated .uasm assembly
console.log(result.tac);  // Intermediate TAC representation
```

### With Optimization

```typescript
const result = transpiler.transpile(sourceCode, { optimize: true });
```

### Demo

Run the included demo to see the transpiler in action:

```bash
npx tsx scripts/transpiler-demo.ts
```

## Project Structure

```
src/transpiler/
├── frontend/          # TypeScript parsing and symbol management
│   ├── parser.ts      # TypeScript AST parser
│   ├── symbol_table.ts # Variable scope tracking
│   └── types.ts       # AST node definitions and type mapping
├── ir/                # Intermediate representation (TAC)
│   ├── tac_instruction.ts  # TAC instruction types
│   ├── tac_operand.ts      # TAC operand types
│   ├── ast_to_tac.ts       # AST → TAC converter
│   └── optimizer.ts        # Optimization passes
├── codegen/           # Udon Assembly generation
│   ├── udon_instruction.ts # Udon instruction types
│   ├── tac_to_udon.ts      # TAC → Udon converter
│   └── udon_assembler.ts   # .uasm file generator
└── index.ts           # Main entry point
```

## Testing

The transpiler includes comprehensive test coverage:

- **Unit Tests**: 23 tests covering parser, TAC generation, and Udon codegen
- **Integration Tests**: 9 tests validating complete transpilation pipeline

```bash
# Run all transpiler tests
npm test -- tests/unit/transpiler tests/integration/transpiler

# Run specific test suite
npm test -- tests/unit/transpiler/parser.test.ts
```

## Output Format

The transpiler generates valid Udon Assembly (.uasm) files with the following structure:

```
.data_start
    .extern Add(Int32, Int32) -> Int32
    .extern LessThan(Int32, Int32) -> Boolean
    .export x
    .export y
.data_end

.code_start
    PUSH 0
    PUSH 10
    COPY
    PUSH 1
    PUSH 20
    COPY
    ...
.code_end
```

## Limitations

Current limitations (not yet implemented):

- Function definitions and calls (only extern calls supported)
- Arrays and array operations
- Complex types (objects, classes)
- Return statements
- For loops and other control flow
- String operations beyond basic literals

## Future Improvements

Planned enhancements:

1. Function definition and local function calls
2. Array access and manipulation
3. Advanced optimizations (register allocation, CSE)
4. Error messages and diagnostics
5. Source maps for debugging
6. VRChat runtime validation

## Performance

The transpiler is designed for fast compilation:

- Constant folding reduces runtime computation
- Dead code elimination reduces binary size
- Minimal memory allocation during transpilation

## Development

See the [Exec Plan](../../z/typescript_to_udon_tac_execplan.md) for detailed implementation notes and design decisions.

## License

Part of the mahjong-t2 project. See repository root for license information.

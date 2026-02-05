# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**udon-assembly-ts** is a TypeScript to Udon Assembly transpiler for VRChat scripting. It converts TypeScript code to Udon Assembly (.uasm), which runs on VRChat's Udon virtual machine. The project also provides UdonSharp-compatible type stubs for development.

## Build & Development Commands

```bash
# Install dependencies
pnpm install

# Build the project (generates dist/)
pnpm build

# Type checking
pnpm typecheck

# Run all tests
pnpm test

# Run a single test file
pnpm vitest tests/unit/transpiler/parser_phase2.test.ts

# Format code (preview)
pnpm format

# Fix formatting and linting
pnpm format:fix
pnpm lint:fix

# CLI usage (from dist/)
node dist/cli/index.js -i src -o output/transpiler
```

## Architecture Overview

The transpiler uses a **5-phase pipeline**:

### Phase 1: Parse (TypeScript → AST)
- **Parser**: `src/transpiler/frontend/parser/index.ts`
- Parses TypeScript source using TypeScript compiler API
- Produces an AST with support for classes, decorators, methods, properties
- Key types in `src/transpiler/frontend/types.ts`: `ASTNodeKind`, `ClassDeclarationNode`, `ProgramNode`

### Phase 2: Semantic Analysis
- **ClassRegistry**: Registers classes, validates inheritance, tracks entry points
- **SymbolTable**: Tracks variable/method scopes and types
- **CallAnalyzer**: Analyzes method call graphs to identify inline classes and heap usage
- **UdonBehaviourLayouts**: Determines method export names for VRChat lifecycle (Start, Update, etc.)

### Phase 3: IR Generation (AST → TAC)
- **ASTToTACConverter**: `src/transpiler/ir/ast_to_tac/index.ts`
- Converts AST to Three-Address Code (TAC) intermediate representation
- TAC Instructions defined in `src/transpiler/ir/tac_instruction.ts`:
  - `AssignmentInstruction`, `BinaryOpInstruction`, `CallInstruction`, `MethodCallInstruction`
  - `ConditionalJumpInstruction`, `ReturnInstruction`, `PropertyGetInstruction`, etc.
- Each instruction uses TAC operands (variables, constants, labels)

### Phase 4: Optimization (TAC → TAC)
- **TACOptimizer**: `src/transpiler/ir/optimizer/index.ts`
- Optional optimization pass (enabled with `optimize: true`)
- Passes in `src/transpiler/ir/optimizer/passes/`:
  - Copy-on-Write (CoW) elimination, dead code elimination, constant folding
  - Data flow analysis in `src/transpiler/ir/optimizer/analysis/`

### Phase 5: Code Generation (TAC → Udon Assembly)
- **TACToUdonConverter**: `src/transpiler/codegen/tac_to_udon/index.ts`
- Converts TAC to Udon instructions (native Udon VM opcodes)
- Manages heap allocation, method exports, extern signatures
- **UdonAssembler**: `src/transpiler/codegen/udon_assembler.ts`
- Generates final .uasm text format with proper headers

### Additional Subsystems

**Stubs** (`src/stubs/`): UdonSharp-compatible type definitions
- `UdonBehaviour.ts`: Base class for Udon scripts
- `UdonDecorators.ts`: @UdonBehaviour, @EntryPoint decorators
- `UdonTypes.ts`: Udon native types (VRCDate, UdonBehaviour, etc.)
- `VRChatTypes.ts`: VRChat API types (VRCPlayerApi, Networking, etc.)
- `UnityTypes.ts`: Unity types (Vector3, Transform, Rigidbody, etc.)

**CLI** (`src/cli/index.ts`): Batch transpiler for directory processing

**Batch Transpiler** (`src/transpiler/batch/batch_transpiler.ts`): Processes multiple files, caches results

**Error Handling** (`src/transpiler/errors/`): Collects and reports transpilation errors

**Heap Limits** (`src/transpiler/heap_limits.ts`): Validates Udon heap usage stays under limit (65536 bytes)

**VRC Event Registry** (`src/transpiler/vrc/event_registry.ts`): Maps VRChat lifecycle events

## Key Patterns

### Class Registration
Classes are registered in `ClassRegistry` during semantic analysis:
```ts
registry.registerFromProgram(ast, sourceId);
const entries = registry.getAllClasses();
```

### TAC Conversion
When converting expressions/statements to TAC, use `ASTToTACConverter`:
```ts
const tacConverter = new ASTToTACConverter(symbolTable, enumRegistry, ...);
const instructions = tacConverter.convert(ast);
```

### TAC Instructions
Create instructions by calling builder methods on converters. Each instruction has operands:
- Register: `new Variable("x")`
- Constant: `new Constant("123", "Int32")`
- Label: `new Label("loop_start")`

### Type Mapping
Type mappings (TypeScript → Udon) are handled in `src/transpiler/frontend/type_mapper.ts`. Udon types are distinct from TypeScript types and must be tracked separately.

## File Organization

```
src/
├── index.ts                           # Public API entrypoint
├── transpiler/
│   ├── index.ts                       # Main TypeScriptToUdonTranspiler class
│   ├── frontend/                      # Parsing & semantic analysis
│   │   ├── parser/                    # TypeScript parser
│   │   ├── class_registry.ts
│   │   ├── symbol_table.ts
│   │   ├── call_analyzer.ts
│   │   └── types.ts                   # AST node types
│   ├── ir/                            # Intermediate representation (TAC)
│   │   ├── ast_to_tac/                # AST to TAC conversion
│   │   ├── optimizer/                 # TAC optimization passes
│   │   ├── tac_instruction.ts         # TAC instruction definitions
│   │   └── tac_operand.ts             # TAC operand types
│   ├── codegen/                       # Code generation (TAC to Udon)
│   │   ├── tac_to_udon/               # TAC to Udon conversion
│   │   ├── udon_instruction.ts        # Udon instruction definitions
│   │   └── udon_assembler.ts          # Final assembly to .uasm
│   ├── batch/                         # Batch file transpilation
│   ├── errors/                        # Error collection & reporting
│   ├── vrc/                           # VRChat-specific logic
│   └── heap_limits.ts                 # Heap validation
├── stubs/                             # UdonSharp-compatible types
└── cli/                               # Command-line interface
```

## Testing Structure

Tests are in `tests/unit/transpiler/`. Common test patterns:

```ts
import { TypeScriptToUdonTranspiler } from "src/transpiler/index.js";

const transpiler = new TypeScriptToUdonTranspiler();
const result = transpiler.transpile(sourceCode);
expect(result.uasm).toContain("...expected output");
expect(result.tac).toContain("...expected TAC");
```

Test files are organized by feature:
- `parser_phase2.test.ts`: Parser tests
- `expressions.test.ts`: Expression transpilation
- `generics.test.ts`: Generic type handling
- `collections.test.ts`: Array/collection types
- `optimizer_*.test.ts`: Optimizer passes
- `class_registry.test.ts`: Class registration & inheritance

## Configuration

- **tsconfig.json**: ESNext target, strict mode, TypeScript 5.9+
- **biome.json**: Formatter (2-space indent), linter with strict rules (no implicit any, no unused variables)
- **tsup.config.ts**: Build configuration; outputs ESM, generates .d.ts files, two entry points (main + CLI)
- **vitest.config.ts**: Test runner with global test APIs enabled

## Key Dependencies

- **TypeScript 5.9+**: AST parsing, type information
- **@biomejs/biome**: Formatting & linting
- **tsup**: Build tool
- **vitest**: Test framework
- **tsx**: TypeScript executor (dev only)

## Important Notes

1. **No Optimization by Default**: TAC optimization is disabled unless explicitly requested with `optimize: true`
2. **Heap Limits**: The transpiler warns if compiled code exceeds 65536 bytes of heap
3. **Entry Points**: The transpiler identifies entry classes (marked with @EntryPoint or first class in file)
4. **Reflection Metadata**: Pass `reflect: true` to append type metadata to the data section
5. **External References**: External types can be loaded from submodules (`external/vrchat-creator-docs`, `external/merlinvr-udonsharp`)

## Debugging Tips

- Enable verbose logging in the CLI with `-v` flag
- Check TAC intermediate representation: `transpiler.transpile(code, {}).tac`
- Inspect heap usage breakdown if warnings appear
- Look at `ErrorCollector` for detailed transpilation errors
- Run specific tests: `pnpm test -- --grep "pattern"` (vitest glob pattern)

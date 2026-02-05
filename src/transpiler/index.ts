/**
 * Main transpiler pipeline: TypeScript -> TAC -> Udon Assembly
 */

import { buildExternRegistryFromFiles } from "./codegen/extern_registry.js";
import { TACToUdonConverter } from "./codegen/tac_to_udon.js";
import { computeTypeId } from "./codegen/type_metadata_registry.js";
import { UdonAssembler } from "./codegen/udon_assembler.js";
import { CallAnalyzer } from "./frontend/call_analyzer.js";
import { ClassRegistry } from "./frontend/class_registry.js";
import { TypeScriptParser } from "./frontend/parser.js";
import {
  ASTNodeKind,
  type ClassDeclarationNode,
  type ProgramNode,
} from "./frontend/types.js";
import {
  buildHeapUsageBreakdown,
  computeHeapUsage,
  UASM_HEAP_LIMIT,
} from "./heap_limits.js";
import { ASTToTACConverter } from "./ir/ast_to_tac.js";
import { TACOptimizer } from "./ir/optimizer.js";
import { buildUdonBehaviourLayouts } from "./ir/udon_behaviour_layout.js";

/**
 * Transpiler options
 */
export interface TranspilerOptions {
  optimize?: boolean;
  reflect?: boolean;
}

/**
 * Transpiler result
 */
export interface TranspilerResult {
  uasm: string;
  tac: string;
}

/**
 * Main transpiler class
 */
export class TypeScriptToUdonTranspiler {
  private static readonly INLINE_SOURCE_ID = "<inline>";
  /**
   * Transpile TypeScript source to Udon Assembly
   */
  transpile(source: string, options: TranspilerOptions = {}): TranspilerResult {
    buildExternRegistryFromFiles([]);
    // Phase 1: Parse TypeScript to AST
    const parser = new TypeScriptParser();
    const ast = parser.parse(source);
    const symbolTable = parser.getSymbolTable();
    const udonBehaviourClasses = new Set(
      ast.statements
        .filter(
          (node): node is ClassDeclarationNode =>
            node.kind === ASTNodeKind.ClassDeclaration,
        )
        .filter((cls) =>
          cls.decorators.some(
            (decorator) => decorator.name === "UdonBehaviour",
          ),
        )
        .map((cls) => cls.name),
    );
    const udonBehaviourLayouts = buildUdonBehaviourLayouts(
      ast.statements
        .filter(
          (node): node is ClassDeclarationNode =>
            node.kind === ASTNodeKind.ClassDeclaration,
        )
        .map((cls) => ({
          name: cls.name,
          isUdonBehaviour: cls.decorators.some(
            (decorator) => decorator.name === "UdonBehaviour",
          ),
          methods: cls.methods.map((method) => ({
            name: method.name,
            parameters: method.parameters.map((param) => ({
              name: param.name,
              type: param.type,
            })),
            returnType: method.returnType,
            isPublic: method.isPublic,
          })),
        })),
    );

    // Phase 2: Convert AST to TAC
    const tacConverter = new ASTToTACConverter(
      symbolTable,
      parser.getEnumRegistry(),
      udonBehaviourClasses,
      udonBehaviourLayouts,
    );
    let tacInstructions = tacConverter.convert(ast);

    // Phase 3: Optimize TAC (only when explicitly enabled)
    if (options.optimize === true) {
      const optimizer = new TACOptimizer();
      tacInstructions = optimizer.optimize(tacInstructions);
    }

    // Generate TAC text representation
    const tacText = tacInstructions.map((inst) => inst.toString()).join("\n");

    // Phase 4: Convert TAC to Udon instructions
    const udonConverter = new TACToUdonConverter();
    const entryClassName = this.pickEntryClassName(ast);
    const inlineClassNames = this.collectInlineClassNames(ast, entryClassName);
    const udonInstructions = udonConverter.convert(tacInstructions, {
      entryClassName: entryClassName ?? undefined,
      inlineClassNames,
    });
    const externSignatures = udonConverter.getExternSignatures();
    let dataSectionWithTypes = udonConverter.getDataSectionWithTypes();
    if (options.reflect === true) {
      dataSectionWithTypes = this.appendReflectionData(
        dataSectionWithTypes,
        ast,
      );
    }

    // Phase 5: Generate .uasm file
    const exportLabels = new Set<string>();
    for (const layout of udonBehaviourLayouts.values()) {
      for (const methodLayout of layout.values()) {
        if (methodLayout.isPublic)
          exportLabels.add(methodLayout.exportMethodName);
      }
    }
    const assembler = new UdonAssembler();
    const uasm = assembler.assemble(
      udonInstructions,
      externSignatures,
      dataSectionWithTypes,
      undefined,
      undefined,
      exportLabels,
    );

    this.ensureHeapWithinLimit(
      entryClassName,
      dataSectionWithTypes,
      udonConverter.getHeapUsageByClass(),
      inlineClassNames,
    );

    return {
      uasm,
      tac: tacText,
    };
  }

  private ensureHeapWithinLimit(
    entryClassName: string | null,
    dataSection: Array<[string, number, string, unknown]>,
    usageByClass: Map<string, number>,
    inlineClassNames?: Set<string>,
  ): void {
    const heapLimit = UASM_HEAP_LIMIT;
    const heapUsage = computeHeapUsage(dataSection);
    if (heapUsage <= heapLimit) return;

    const entryKey = entryClassName ?? "<global>";
    const breakdown = buildHeapUsageBreakdown(
      usageByClass,
      heapUsage,
      entryKey,
      inlineClassNames,
    );
    const entryLabel = entryClassName ? ` for ${entryClassName}` : "";
    const message = [
      `UASM heap usage ${heapUsage} exceeds limit ${heapLimit}${entryLabel}.`,
      "Heap usage by class:",
      breakdown || "  - <no data>",
    ].join("\n");
    console.warn(message);
  }

  private pickEntryClassName(program: ProgramNode): string | null {
    const registry = new ClassRegistry();
    registry.registerFromProgram(
      program,
      TypeScriptToUdonTranspiler.INLINE_SOURCE_ID,
    );
    const entryPoint =
      registry.getEntryPoints()[0]?.name ?? registry.getAllClasses()[0]?.name;
    return entryPoint ?? null;
  }

  private collectInlineClassNames(
    program: ProgramNode,
    entryClassName: string | null,
  ): Set<string> {
    if (!entryClassName) return new Set();
    const registry = new ClassRegistry();
    registry.registerFromProgram(
      program,
      TypeScriptToUdonTranspiler.INLINE_SOURCE_ID,
    );
    const analyzer = new CallAnalyzer(registry);
    return analyzer.analyzeClass(entryClassName).inlineClasses;
  }

  private appendReflectionData(
    dataSection: Array<[string, number, string, unknown]>,
    program: ProgramNode,
  ): Array<[string, number, string, unknown]> {
    const classNodes = program.statements.filter(
      (node): node is ClassDeclarationNode =>
        node.kind === ASTNodeKind.ClassDeclaration,
    );
    if (classNodes.length === 0) return dataSection;

    let maxAddress = dataSection.reduce(
      (max, entry) => Math.max(max, entry[1]),
      -1,
    );
    const nextAddress = () => {
      maxAddress += 1;
      return maxAddress;
    };

    const entries: Array<[string, number, string, unknown]> = [];
    for (const cls of classNodes) {
      const typeId = computeTypeId(cls.name);
      const hexId = `0x${typeId.toString(16)}`;
      entries.push(["__refl_typeid", nextAddress(), "Int64", hexId]);
      entries.push(["__refl_typename", nextAddress(), "String", cls.name]);
      entries.push(["__refl_typeids", nextAddress(), "Int64Array", null]);
      break;
    }

    return [...dataSection, ...entries];
  }
}

export {
  type BatchFileResult,
  type BatchResult,
  BatchTranspiler,
  type BatchTranspilerOptions,
} from "./batch/batch_transpiler.js";
export { TACToUdonConverter } from "./codegen/tac_to_udon.js";
export { UdonAssembler } from "./codegen/udon_assembler.js";
export * from "./codegen/udon_instruction.js";
export { ErrorCollector } from "./errors/error_collector.js";
export * from "./errors/transpile_errors.js";
export { ClassRegistry } from "./frontend/class_registry.js";
export { InheritanceValidator } from "./frontend/inheritance_validator.js";
// Export all main classes
export { TypeScriptParser } from "./frontend/parser.js";
export { SymbolTable } from "./frontend/symbol_table.js";
export * from "./frontend/types.js";
export { ASTToTACConverter } from "./ir/ast_to_tac.js";
export { TACOptimizer } from "./ir/optimizer.js";
export {
  ArrayAccessInstruction,
  ArrayAssignmentInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  CastInstruction,
  ConditionalJumpInstruction,
  CopyInstruction as TACCopyInstruction,
  LabelInstruction as TACLabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  PropertySetInstruction,
  ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnaryOpInstruction,
  UnconditionalJumpInstruction,
} from "./ir/tac_instruction.js";
export * from "./ir/tac_operand.js";

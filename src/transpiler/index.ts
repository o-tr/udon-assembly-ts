/**
 * Main transpiler pipeline: TypeScript -> TAC -> Udon Assembly
 */

import { buildExternRegistryFromFiles } from "./codegen/extern_registry.js";
import { appendReflectionData } from "./codegen/reflection.js";
import { TACToUdonConverter } from "./codegen/tac_to_udon/index.js";
import { UdonAssembler } from "./codegen/udon_assembler.js";
import {
  formatWarnings,
  type TranspileWarning,
} from "./errors/transpile_errors.js";
import { computeExportLabels, computeExposedLabels } from "./exposed_labels.js";
import { CallAnalyzer } from "./frontend/call_analyzer.js";
import { ClassRegistry } from "./frontend/class_registry.js";
import { MethodUsageAnalyzer } from "./frontend/method_usage_analyzer.js";
import { TypeScriptParser } from "./frontend/parser/index.js";
import { resolveDeferredTypes } from "./frontend/post_parse_resolver.js";
import { TypeCheckerContext } from "./frontend/type_checker_context.js";
import { ASTNodeKind, type ClassDeclarationNode } from "./frontend/types.js";
import {
  buildSimpleHeapBreakdown,
  computeHeapUsage,
  UASM_HEAP_LIMIT,
} from "./heap_limits.js";
import { ASTToTACConverter } from "./ir/ast_to_tac/index.js";
import { TACOptimizer } from "./ir/optimizer/index.js";
import { pruneProgramByMethodUsage } from "./ir/optimizer/ipa.js";
import { buildUdonBehaviourLayouts } from "./ir/udon_behaviour_layout.js";

/**
 * Transpiler options
 */
export interface TranspilerOptions {
  optimize?: boolean;
  reflect?: boolean;
  useStringBuilder?: boolean;
  sourceFilePath?: string;
  /**
   * When true, suppress the automatic `console.warn(formatWarnings(...))`
   * emission at the end of transpile(). Structured diagnostics are still
   * available on `result.diagnostics`. Useful for IDE integrations and
   * test harnesses that render warnings themselves.
   */
  silent?: boolean;
}

/**
 * Transpiler result
 */
export interface TranspilerResult {
  uasm: string;
  tac: string;
  warnings?: string[];
  diagnostics?: TranspileWarning[];
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
    const sourceFilePath =
      options.sourceFilePath ?? TypeScriptToUdonTranspiler.INLINE_SOURCE_ID;
    // Phase 1: Parse TypeScript to AST
    const checkerContext = TypeCheckerContext.create({
      rootNames: [sourceFilePath],
      inMemorySources: { [sourceFilePath]: source },
    });
    const parser = new TypeScriptParser(undefined, checkerContext);
    const ast = parser.parse(source, sourceFilePath);
    resolveDeferredTypes(ast, parser.typeMapper);
    const registry = new ClassRegistry();
    registry.registerFromProgram(ast, sourceFilePath);
    const symbolTable = parser.getSymbolTable();
    let program = ast;
    if (options.optimize === true) {
      const usage = new MethodUsageAnalyzer(registry).analyze();
      program = pruneProgramByMethodUsage(program, usage);
    }
    const classDecls = program.statements.filter(
      (node): node is ClassDeclarationNode =>
        node.kind === ASTNodeKind.ClassDeclaration,
    );
    const entryClassName = this.pickEntryClassName(registry);
    const udonBehaviourClasses = new Set(
      classDecls
        .filter((cls) =>
          cls.decorators.some(
            (decorator) => decorator.name === "UdonBehaviour",
          ),
        )
        .map((cls) => cls.name),
    );
    const udonBehaviourInterfaces = registry.getUdonBehaviourInterfaces();
    const interfaceLikes = Array.from(udonBehaviourInterfaces.values()).map(
      (iface) => ({
        name: iface.name,
        methods: iface.methods.map((m) => ({
          name: m.name,
          parameters: m.parameters.map((p) => ({
            name: p.name,
            type: p.type,
          })),
          returnType: m.returnType,
        })),
      }),
    );
    const classImplements = registry.getClassImplementsMap();
    const udonBehaviourLayouts = buildUdonBehaviourLayouts(
      classDecls.map((cls) => ({
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
      interfaceLikes,
      classImplements,
    );

    // Phase 2: Convert AST to TAC
    const tacConverter = new ASTToTACConverter(
      symbolTable,
      parser.getEnumRegistry(),
      udonBehaviourClasses,
      udonBehaviourLayouts,
      registry,
      {
        useStringBuilder: options.useStringBuilder,
        typeMapper: parser.typeMapper,
        sourceFilePath,
        errorCollector: parser.getErrorCollector(),
        checkerContext: parser.checkerContext,
        checkerTypeResolver: parser.checkerTypeResolver,
      },
    );
    let tacInstructions = tacConverter.convert(program);

    // Phase 3: Optimize TAC (only when explicitly enabled)
    if (options.optimize === true) {
      const optimizer = new TACOptimizer();
      const exposedLabels = computeExposedLabels(
        registry,
        udonBehaviourLayouts,
        entryClassName,
      );
      tacInstructions = optimizer.optimize(tacInstructions, exposedLabels);
    }

    // Generate TAC text representation
    const tacText = tacInstructions.map((inst) => inst.toString()).join("\n");

    // Phase 4: Convert TAC to Udon instructions
    const udonConverter = new TACToUdonConverter();
    const inlineClassNames = this.collectInlineClassNames(
      registry,
      entryClassName,
    );
    const udonInstructions = udonConverter.convert(tacInstructions, {
      entryClassName: entryClassName ?? undefined,
      inlineClassNames,
    });
    const externSignatures = udonConverter.getExternSignatures();
    let dataSectionWithTypes = udonConverter.getDataSectionWithTypes();
    if (options.reflect === true && entryClassName) {
      dataSectionWithTypes = appendReflectionData(
        dataSectionWithTypes,
        entryClassName,
      );
    }

    // Phase 5: Generate .uasm file
    const exportLabels = computeExportLabels(
      registry,
      udonBehaviourLayouts,
      entryClassName,
    );
    const assembler = new UdonAssembler();
    const uasm = assembler.assemble(
      udonInstructions,
      externSignatures,
      dataSectionWithTypes,
      undefined,
      undefined,
      exportLabels,
    );

    const heapUsage = computeHeapUsage(dataSectionWithTypes);
    if (heapUsage > UASM_HEAP_LIMIT) {
      const entryLabel = entryClassName ? ` for ${entryClassName}` : "";
      const breakdown = buildSimpleHeapBreakdown(
        udonConverter.getHeapUsageByClass(),
        heapUsage,
        entryClassName ?? "<global>",
      );
      console.warn(
        `UASM heap usage ${heapUsage} exceeds limit ${UASM_HEAP_LIMIT}${entryLabel}.\nHeap usage by class:\n${breakdown}`,
      );
    }

    const warnings = assembler.getWarnings();
    const diagnostics = parser.getErrorCollector().getWarnings();
    if (diagnostics.length > 0 && !options.silent) {
      console.warn(formatWarnings(diagnostics));
    }
    return {
      uasm,
      tac: tacText,
      warnings: warnings.length > 0 ? warnings : undefined,
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    };
  }

  private pickEntryClassName(registry: ClassRegistry): string | null {
    const entryPoint =
      registry.getEntryPoints()[0]?.name ?? registry.getAllClasses()[0]?.name;
    return entryPoint ?? null;
  }

  private collectInlineClassNames(
    registry: ClassRegistry,
    entryClassName: string | null,
  ): ReadonlySet<string> {
    if (!entryClassName) return new Set();
    const callAnalyzer = new CallAnalyzer(registry);
    return callAnalyzer.analyzeClass(entryClassName).inlineClasses;
  }
}

export {
  type BatchFileResult,
  type BatchResult,
  BatchTranspiler,
  type BatchTranspilerOptions,
  resetTranspilerHash,
} from "./batch/batch_transpiler.js";
export { TACToUdonConverter } from "./codegen/tac_to_udon/index.js";
export { UdonAssembler } from "./codegen/udon_assembler.js";
export * from "./codegen/udon_instruction.js";
export { ErrorCollector } from "./errors/error_collector.js";
export * from "./errors/transpile_errors.js";
export { ClassRegistry } from "./frontend/class_registry.js";
export { InheritanceValidator } from "./frontend/inheritance_validator.js";
// Export all main classes
export { TypeScriptParser } from "./frontend/parser/index.js";
export { SymbolTable } from "./frontend/symbol_table.js";
export * from "./frontend/types.js";
export { ASTToTACConverter } from "./ir/ast_to_tac/index.js";
export { TACOptimizer } from "./ir/optimizer/index.js";
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
  PhiInstruction,
  PropertyGetInstruction,
  PropertySetInstruction,
  ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnaryOpInstruction,
  UnconditionalJumpInstruction,
} from "./ir/tac_instruction.js";
export * from "./ir/tac_operand.js";

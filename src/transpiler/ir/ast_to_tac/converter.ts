/**
 * Convert AST to TAC (Three-Address Code)
 */

import type { ErrorCollector } from "../../errors/error_collector.js";
import {
  formatContext,
  formatLocation,
  type TranspileErrorLocation,
  type TranspileWarningCode,
} from "../../errors/transpile_errors.js";
import type { ClassRegistry } from "../../frontend/class_registry.js";
import { EnumRegistry } from "../../frontend/enum_registry.js";
import type { SymbolTable } from "../../frontend/symbol_table.js";
import type { TypeCheckerContext } from "../../frontend/type_checker_context.js";
import {
  createTypeCheckerTypeResolver,
  type TypeCheckerTypeResolver,
} from "../../frontend/type_checker_type_resolver.js";
import { TypeMapper } from "../../frontend/type_mapper.js";
import type { TypeSymbol } from "../../frontend/type_symbols.js";
import {
  InterfaceTypeSymbol,
  PrimitiveTypes,
} from "../../frontend/type_symbols.js";
import {
  type ASTNode,
  ASTNodeKind,
  type ClassDeclarationNode,
  type ProgramNode,
  type VariableDeclarationNode,
} from "../../frontend/types.js";
import { getVrcEventDefinition } from "../../vrc/event_registry.js";
import {
  LabelInstruction,
  ReturnInstruction,
  type TACInstruction,
} from "../tac_instruction.js";
import {
  createLabel,
  createTemporary,
  type TACOperand,
  type VariableOperand,
} from "../tac_operand.js";
import type {
  UdonBehaviourLayouts,
  UdonBehaviourMethodLayout,
} from "../udon_behaviour_layout.js";
import {
  assignToTarget,
  coerceConstantToType,
  getArrayElementType,
  getOperandType,
  isNullableType,
  isStatementNode,
  unwrapDataToken,
  visitAssignmentExpression,
  visitUpdateExpression,
  wrapDataToken,
} from "./helpers/assignment.js";
import { coerceToBoolean } from "./helpers/coerce_boolean.js";
import {
  emitDataDictionaryEntries,
  emitDataDictionaryKeys,
  emitDataDictionaryValues,
  emitDictionaryFromProperties,
} from "./helpers/data_dictionary.js";
import { requireExternSignature } from "./helpers/extern.js";
import {
  allocateBodyCachedInstance,
  collectRecursiveLocals,
  emitCallSitePop,
  emitCallSitePush,
  emitCopyWithTracking,
  emitEntryPointPropertyInit,
  emitInlineRecursivePop,
  emitInlineRecursivePush,
  emitReturnSiteDispatch,
  mapInlineProperty,
  mapStaticProperty,
  maybeTrackInlineInstanceAssignment,
  resolveInlineInstance,
  tryResolveUnitySelfReference,
  visitInlineConstructor,
  visitInlineInstanceMethodCall,
  visitInlineInstanceMethodCallWithContext,
  visitInlineStaticMethodCall,
} from "./helpers/inline.js";
import { analyzeNativeArrayIneligibility } from "./helpers/native_array_analysis.js";
import {
  coerceSwitchOperand,
  isSwitchComparableType,
} from "./helpers/switch.js";
import {
  mergeTemplateParts,
  templateLiteralValueToString,
  tryFoldTemplateExpression,
} from "./helpers/template.js";
import {
  emitTryInstructionsWithChecks,
  getCheckOperand,
} from "./helpers/try_catch.js";
import {
  emitOnDeserializationForFieldChangeCallbacks,
  getUdonBehaviourLayout,
  isAllInlineInterface,
  isUdonBehaviourPropertyAccess,
  isUdonBehaviourType,
  resolveFieldChangeCallback,
} from "./helpers/udon_behaviour.js";
import {
  getUdonTypeConverterTargetType,
  resolveStaticExtern,
  visitArrayStaticCall,
  visitCallExpression,
  visitMathStaticCall,
  visitNumberStaticCall,
  visitObjectStaticCall,
} from "./visitors/call.js";
import {
  visitArrayAccessExpression,
  visitArrayLiteralExpression,
  visitAsExpression,
  visitBinaryExpression,
  visitConditionalExpression,
  visitDeleteExpression,
  visitExpression,
  visitIdentifier,
  visitLiteral,
  visitNameofExpression,
  visitNullCoalescingExpression,
  visitObjectLiteralExpression,
  visitOptionalChainingExpression,
  visitPropertyAccessExpression,
  visitShortCircuitAnd,
  visitShortCircuitOr,
  visitSuperExpression,
  visitTemplateExpression,
  visitThisExpression,
  visitTypeofExpression,
  visitUnaryExpression,
} from "./visitors/expression.js";
import {
  isDestructureBlock,
  visitBlockStatement,
  visitBreakStatement,
  visitClassDeclaration,
  visitContinueStatement,
  visitDoWhileStatement,
  visitEnumDeclaration,
  visitForOfStatement,
  visitForStatement,
  visitIfStatement,
  visitInlineBlockStatement,
  visitReturnStatement,
  visitStatement,
  visitSwitchStatement,
  visitThrowStatement,
  visitTryCatchStatement,
  visitVariableDeclaration,
  visitWhileStatement,
} from "./visitors/statement.js";

/**
 * AST to TAC converter
 */
export class ASTToTACConverter {
  instructions: TACInstruction[] = [];
  /**
   * When true, emit() is a no-op. Pass 1 runs in this mode to collect
   * metadata (allInlineInstances, interfaceClassIdMap, soaClasses) without
   * producing TAC instructions or firing diagnostic warnings — new warn
   * sites must call warnAt() (which suppresses internally when this flag
   * is set) rather than console.warn directly, otherwise diagnostics are
   * duplicated across the two passes.
   */
  metadataOnlyMode = false;
  tempCounter = 0;
  labelCounter = 0;
  instanceCounter = 0;
  /** Separate counter for __viface_ prefixes so it never shifts instanceCounter
   *  between pass 1 and pass 2 (viface blocks fire in pass 2 but not pass 1). */
  vifaceCounter = 0;
  useStringBuilder = true;
  stringBuilderThreshold = 6;
  symbolTable: SymbolTable;
  currentReturnVar: string | undefined;
  currentClassName: string | undefined;
  currentMethodName: string | undefined;
  currentInlineContext:
    | { className: string; instancePrefix: string }
    | undefined;
  currentRecursiveContext:
    | {
        locals: Array<{ name: string; type: TypeSymbol }>;
        depthVar: string;
        spVar: string;
        stackVars: Array<{ name: string; type: TypeSymbol }>;
        returnSites: Array<{ index: number; labelName: string }>;
        nextSelfCallResultIndex?: number;
        dispatchLabel: TACOperand;
        overflowLabel: TACOperand;
      }
    | undefined;
  /**
   * Recursion context for inline static methods (e.g.
   * HandDecompositionHelpers.checkMelds). Uses the same JUMP-based
   * call/return pattern as @RecursiveMethod but is set up inside
   * visitInlineStaticMethodCall rather than the entry-point method emitter.
   */
  currentInlineRecursiveContext:
    | {
        className: string;
        methodName: string;
        locals: Array<{ name: string; type: TypeSymbol }>;
        depthVar: string;
        spVar: string;
        stackVars: Array<{ name: string; type: TypeSymbol }>;
        returnSites: Array<{ index: number; labelName: string }>;
        nextReturnSiteIndex: number;
        nextSelfCallResultIndex: number;
        entryLabel: TACOperand;
        dispatchLabel: TACOperand;
        overflowLabel: TACOperand;
        returnVar: VariableOperand;
      }
    | undefined;
  /**
   * Shared return site registries keyed by "className.methodName".
   * Both callers (from Start) and the recursive method itself register here.
   */
  recursiveReturnSites: Map<
    string,
    { sites: Array<{ index: number; labelName: string }>; nextIndex: number }
  > = new Map();
  loopContextStack: Array<{
    breakLabel: TACOperand;
    continueLabel: TACOperand;
    emitExitEpilogue?: () => void;
  }> = [];
  tryCounter = 0;
  tryContextStack: Array<{
    errorFlag: VariableOperand;
    errorValue: VariableOperand;
    errorTarget: TACOperand;
    loopDepth: number;
  }> = [];
  inlineReturnStack: Array<{
    returnVar: VariableOperand;
    returnLabel: TACOperand;
    returnTrackingInvalidated: boolean;
    loopDepth: number;
    returnInstancePrefix?: string;
    isErasedReturn?: boolean;
  }> = [];
  currentThisOverride: TACOperand | null = null;
  propertyAccessDepth = 0;
  typeMapper: TypeMapper;
  enumRegistry: EnumRegistry;
  classMap: Map<string, ClassDeclarationNode> = new Map();
  entryPointClasses: Set<string> = new Set();
  /** Tracks which classes have had their static property initializers emitted */
  emittedStaticClasses: Set<string> = new Set();
  inlineInstanceMap: Map<string, { prefix: string; className: string }> =
    new Map();
  inlineMethodStack: Set<string> = new Set();
  /** Maps interface name → (class name → classId) for inline dispatch */
  interfaceClassIdMap: Map<string, Map<string, number>> = new Map();
  /** Maps instanceId → {prefix, className} for all inline instances */
  allInlineInstances: Map<number, { prefix: string; className: string }> =
    new Map();
  /**
   * Classes whose constructor is invoked inside a loop body.
   * Detected in pass 1; pre-seeded into pass 2.
   * SoA classes use per-field DataLists instead of per-instance heap variables,
   * so each loop iteration stores field values at a distinct DataList index.
   */
  soaClasses: Set<string> = new Set();
  /** Per-class, per-field DataList variable for SoA storage.
   *  Key: className → fieldName → VariableOperand (DataList). */
  soaFieldLists: Map<string, Map<string, VariableOperand>> = new Map();
  /** Per-class, per-field declared type for SoA storage.
   *  Key: className → fieldName → TypeSymbol. */
  soaFieldTypes: Map<string, Map<string, TypeSymbol>> = new Map();
  /** Per-class runtime counter variable (Int32).
   *  Handle = counter value at construction time. */
  soaCounterVars: Map<string, VariableOperand> = new Map();
  /** Tracks whether SoA DataLists + counter have been initialized for each class. */
  soaInitialized: Set<string> = new Set();
  /**
   * Tracks SoA instance prefixes currently being constructed (between the start
   * of visitInlineConstructor and the SoA epilogue). Used to distinguish
   * in-constructor field reads (which must use the scratch variable) from
   * post-construction reads (which must go through the per-field DataList).
   */
  soaConstructionPrefixes: Set<string> = new Set();
  // Start at 1: Udon zero-initialises heap slots, so an uninitialised
  // array element holds 0. Reserving 0 as "no valid instance" prevents
  // false dispatch matches on partially-populated interface arrays.
  nextInstanceId = 1;
  /**
   * When a method body is inlined at multiple call sites, each site would
   * normally generate fresh instance IDs for every `new Cls()` inside the body.
   * This creates O(N_call_sites × N_instances) entries in allInlineInstances,
   * causing massive code-size blow-up for flyweight-pattern classes (e.g. Tile).
   *
   * Fix: when the same method body AST node is inlined again, reuse the prefix
   * and instanceId from the first invocation (same position within the body).
   * All invocations then reference the same heap variables and the same runtime
   * handles, so D-3 dispatch and viface dispatch work uniformly across call sites.
   *
   * Cache key: the body AST node object (identity, not structural equality).
   * Cache value: ordered list of {prefix, instanceId} for each constructor call
   *   encountered in visit order within that body.
   */
  methodBodyInstanceCache: Map<
    ASTNode,
    Array<{ prefix: string; instanceId: number }>
  > = new Map();
  /** Per-body call index for the current invocation of that body.
   *  Reset to 0 at the start of each visitInlineStaticMethodCall /
   *  inlineInstanceMethodCallCore invocation so subsequent constructors pick
   *  up from the beginning of the cache. */
  methodBodyConstructorIndex: Map<ASTNode, number> = new Map();
  /** Stack of body AST nodes currently being inlined (innermost at the end).
   *  Used by visitInlineConstructor to know which cache entry to look up. */
  inlinedBodyStack: ASTNode[] = [];
  /** Cache for getImplementorsOfInterface results in expression.ts dispatch.
   *  Keyed by interface name; value is Set<implementor class name> or null when
   *  classRegistry is absent. Reset per pass so stale entries don't survive. */
  implementorNamesCache: Map<string, Set<string> | null> = new Map();
  /** Cache for isAllInlineInterface results to avoid O(N) rescans.
   *  The cache is reset in resetState() before each pass, so it is always
   *  valid within a single pass. ClassRegistry does not change between passes,
   *  so results are identical across passes.
   *  If incremental compilation ever calls register() during convertImpl(),
   *  this cache must be cleared. */
  allInlineInterfaceCache: Map<string, boolean> = new Map();
  udonBehaviourClasses: ReadonlySet<string>;
  udonBehaviourLayouts: UdonBehaviourLayouts;
  classRegistry: ClassRegistry | null;
  currentParamExportMap: Map<string, string> = new Map();
  currentParamExportReverseMap: Map<string, string> = new Map();
  currentMethodLayout: UdonBehaviourMethodLayout | null = null;
  currentInlineBaseClass: string | undefined;
  currentInlineConstructorClassName: string | undefined;
  currentInlineInitializerState:
    | {
        kind: "inline";
        instancePrefix: string;
        entryClassName?: undefined;
        classNodesByName: Map<string, ClassDeclarationNode>;
        emittedClassNames: Set<string>;
      }
    | {
        kind: "entry-point";
        entryClassName: string;
        instancePrefix?: undefined;
        classNodesByName: Map<string, ClassDeclarationNode>;
        emittedClassNames: Set<string>;
      }
    | undefined;
  inSerializeFieldInitializer = false;
  pendingTopLevelInits: VariableDeclarationNode[] = [];
  currentExpectedType: TypeSymbol | undefined = undefined;
  /**
   * Best-effort hint for DataToken `.value` unwrap target types.
   * Keyed by TAC operand tracking key (temporary/variable name).
   */
  dataTokenValueHints: Map<string, TypeSymbol> = new Map();
  /** Variable names ineligible for native array optimization in the current method body. */
  nativeArrayIneligible: Set<string> = new Set();
  /**
   * When non-null, visitArrayLiteralExpression emits a native (fixed-length)
   * array for the named variable rather than a DataList.
   * Set by visitVariableDeclaration immediately before visiting the initializer.
   */
  currentNativeArrayVarName: string | null = null;
  /** Source file path for diagnostic messages; populated from transpile options. */
  sourceFilePath = "<unknown>";
  /** Optional error collector used by warnAt() to record warnings with source locations. */
  errorCollector?: ErrorCollector;
  /** TypeChecker context for resolving TypeScript types at AST nodes. */
  checkerContext?: TypeCheckerContext;
  /** Cached TypeChecker resolver reused across resolveTypeFromNode calls. */
  checkerTypeResolver?: TypeCheckerTypeResolver;
  /** Stack of AST nodes representing active inline call sites (innermost last).
   *  Used by warnAt() so warnings emitted inside an inline body report the
   *  caller's source location instead of the inline definition. */
  inlineCallSiteStack: ASTNode[] = [];
  /** AST node for the current inline constructor invocation (SoA epilogue). */
  currentInlineConstructionSite?: ASTNode;

  constructor(
    symbolTable: SymbolTable,
    enumRegistry?: EnumRegistry,
    udonBehaviourClasses?: ReadonlySet<string>,
    udonBehaviourLayouts?: UdonBehaviourLayouts,
    classRegistry?: ClassRegistry,
    options?: {
      useStringBuilder?: boolean;
      stringBuilderThreshold?: number;
      typeMapper?: TypeMapper;
      sourceFilePath?: string;
      errorCollector?: ErrorCollector;
      checkerContext?: TypeCheckerContext;
      checkerTypeResolver?: TypeCheckerTypeResolver;
    },
  ) {
    this.symbolTable = symbolTable;
    this.enumRegistry = enumRegistry ?? new EnumRegistry();
    this.typeMapper = options?.typeMapper ?? new TypeMapper(this.enumRegistry);
    this.udonBehaviourClasses = udonBehaviourClasses ?? new Set();
    this.udonBehaviourLayouts = udonBehaviourLayouts ?? new Map();
    this.classRegistry = classRegistry ?? null;
    this.useStringBuilder = options?.useStringBuilder !== false;
    this.stringBuilderThreshold =
      options?.stringBuilderThreshold ?? this.stringBuilderThreshold;
    if (options?.sourceFilePath) this.sourceFilePath = options.sourceFilePath;
    this.errorCollector = options?.errorCollector;
    this.checkerContext = options?.checkerContext;
    // Prefer the caller-supplied resolver so its typeCache + fqNameCache
    // survive across batch entry points; otherwise eager-create one tied
    // to the supplied context. Eager construction makes the use-site
    // lazy-create path unreachable, so the optimization can't be lost
    // by a caller silently forgetting to wire the shared resolver.
    if (options?.checkerTypeResolver) {
      this.checkerTypeResolver = options.checkerTypeResolver;
    } else if (this.checkerContext) {
      this.checkerTypeResolver = createTypeCheckerTypeResolver(
        this.checkerContext,
        this.typeMapper,
      );
    }
  }

  /**
   * Resolve source location for a warning emitted by warnAt().
   * Preference order: nearest inline call-site (scanning stack top-down
   * for the first entry with a real `loc`) → passed node → inline
   * constructor site → bare filePath fallback. Scanning skips synthetic
   * AST nodes that were constructed without a tsNode (e.g. destructuring
   * expansions) so warnings still report a useful caller position.
   */
  private resolveWarnLocation(
    node: ASTNode | undefined,
  ): TranspileErrorLocation {
    for (let i = this.inlineCallSiteStack.length - 1; i >= 0; i -= 1) {
      const loc = this.inlineCallSiteStack[i]?.loc;
      if (loc) return loc;
    }
    const candidate = node?.loc ?? this.currentInlineConstructionSite?.loc;
    if (candidate) return candidate;
    return { filePath: this.sourceFilePath, line: 0, column: 0 };
  }

  /**
   * Emit a warning with source location and class/method context.
   * Routed through errorCollector when available; otherwise falls back
   * to console.warn with a formatted prefix.
   */
  warnAt(
    node: ASTNode | undefined,
    code: TranspileWarningCode,
    message: string,
  ): void {
    // Pass 1 (metadataOnlyMode) visits everything a second time; suppress
    // warnings there so diagnostics are not duplicated between passes.
    if (this.metadataOnlyMode) return;
    const location = this.resolveWarnLocation(node);
    // Report the caller's class/method — consistent with resolveWarnLocation's
    // caller-first preference. Inside an inline body, currentInlineContext
    // names the callee class but currentClassName still holds the caller, so
    // always prefer currentClassName here to avoid a mixed (callee.caller)
    // label.
    const context: { className?: string; methodName?: string } = {};
    if (this.currentClassName) {
      context.className = this.currentClassName;
    }
    if (this.currentMethodName) {
      context.methodName = this.currentMethodName;
    }
    const hasContext =
      context.className !== undefined || context.methodName !== undefined;

    if (this.errorCollector) {
      this.errorCollector.addWarning({
        code,
        message,
        location,
        ...(hasContext ? { context } : {}),
      });
      return;
    }

    const ctxStr = hasContext ? formatContext(context) : "";
    console.warn(`[${code}] ${formatLocation(location)}${ctxStr} ${message}`);
  }

  withInlineCallSite<T>(node: ASTNode, fn: () => T): T {
    this.inlineCallSiteStack.push(node);
    try {
      return fn();
    } finally {
      this.inlineCallSiteStack.pop();
    }
  }

  withInlineConstructionSite<T>(node: ASTNode, fn: () => T): T {
    const previous = this.currentInlineConstructionSite;
    this.currentInlineConstructionSite = node;
    try {
      return fn();
    } finally {
      this.currentInlineConstructionSite = previous;
    }
  }

  /**
   * Scan for variable declarations in a block and pre-register them
   */
  scanDeclarations(statements: readonly ASTNode[]): void {
    for (const stmt of statements) {
      if (stmt.kind === ASTNodeKind.VariableDeclaration) {
        const node = stmt as VariableDeclarationNode;
        if (!this.symbolTable.hasInCurrentScope(node.name)) {
          this.symbolTable.addSymbol(
            node.name,
            node.type,
            false,
            node.isConst,
            // propagate initializer so later resolveTypeFromNode can
            // inspect it when the symbol's declared type is generic
            // or unresolved
            node.initializer,
          );
        }
      }
    }
  }

  /**
   * Reset all mutable compilation state (but not constructor args or typeMapper).
   * Called before each compilation pass.
   */
  private resetState(): void {
    this.instructions = [];
    this.metadataOnlyMode = false;
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.instanceCounter = 0;
    this.vifaceCounter = 0;
    this.classMap = new Map();
    this.entryPointClasses = new Set();
    this.emittedStaticClasses = new Set();
    this.inlineInstanceMap = new Map();
    this.inlineMethodStack = new Set();
    this.interfaceClassIdMap = new Map();
    this.allInlineInstances = new Map();
    this.soaClasses = new Set();
    this.soaFieldLists = new Map();
    this.soaFieldTypes = new Map();
    this.soaCounterVars = new Map();
    this.soaInitialized = new Set();
    this.soaConstructionPrefixes = new Set();
    this.implementorNamesCache = new Map();
    this.allInlineInterfaceCache = new Map();
    this.methodBodyInstanceCache = new Map();
    this.methodBodyConstructorIndex = new Map();
    this.inlinedBodyStack = [];
    this.nextInstanceId = 1;
    this.pendingTopLevelInits = [];
    this.currentExpectedType = undefined;
    this.dataTokenValueHints = new Map();
    this.currentInlineBaseClass = undefined;
    this.currentInlineConstructorClassName = undefined;
    this.currentInlineInitializerState = undefined;
    this.recursiveReturnSites = new Map();
    this.currentParamExportMap = new Map();
    this.currentParamExportReverseMap = new Map();
    this.tryCounter = 0;
    // Defensive: these stacks are always balanced for non-throwing execution,
    // but reset them so that any unexpected exception in pass 1 can't leak
    // context into pass 2.
    this.loopContextStack = [];
    this.tryContextStack = [];
    this.inlineReturnStack = [];
    this.inlineCallSiteStack = [];
    this.currentInlineConstructionSite = undefined;
    this.currentReturnVar = undefined;
    this.currentClassName = undefined;
    this.currentMethodName = undefined;
    this.currentInlineContext = undefined;
    this.currentRecursiveContext = undefined;
    this.currentInlineRecursiveContext = undefined;
    this.currentThisOverride = null;
    this.propertyAccessDepth = 0;
    this.currentMethodLayout = null;
    this.inSerializeFieldInitializer = false;
    this.nativeArrayIneligible = new Set();
    this.currentNativeArrayVarName = null;
  }

  /**
   * Emit a TAC instruction. Skipped in metadata-only mode (Pass 1).
   * Single-argument signature avoids rest-parameter array allocation
   * on every call site.
   */
  emit(instruction: TACInstruction): void {
    if (this.metadataOnlyMode) return;
    this.instructions.push(instruction);
  }

  /**
   * Convert program to TAC (two-pass).
   * Pass 1 collects allInlineInstances and interfaceClassIdMap so that
   * forward references (e.g. a Meld instance created *after* the for-of
   * loop that iterates over it) are already known in pass 2.
   */
  convert(program: ProgramNode): TACInstruction[] {
    // Pass 1: collect inline instance and interface metadata; discard output
    this.resetState();
    this.metadataOnlyMode = true;
    this.convertImpl(program);

    // Diagnostic: warn when an all-inline interface is used in source but no
    // constructor for any of its implementors was ever called.  In that case
    // pass 2 will fall through to generic (EXTERN) handling rather than viface
    // dispatch — the same silent failure the old single-pass code had.
    //
    // Emitted here, between pass 1 and resetState(), so that post-pass-1 state
    // (classMap, entryPointClasses, interfaceClassIdMap, …) is still populated
    // — isAllInlineInterface transitively reads classMap / entryPointClasses
    // via isUdonBehaviourClassName, so moving this after resetState() would
    // produce false positives for non-decorated entry-point classes.
    //
    // Only check interfaces whose implementors are actually part of the current
    // compilation unit (program statements), otherwise the warning fires for
    // every entry point that doesn't use the interface — a false positive.
    // Pre-calculate the set of relevant interfaces from program classes to
    // avoid O(I × C) iteration over all interfaces × all classes.
    if (this.classRegistry) {
      const relevantInterfaces = new Set<string>();
      for (const stmt of program.statements) {
        if (stmt.kind !== ASTNodeKind.ClassDeclaration) continue;
        for (const iface of this.classRegistry.getAllImplementedInterfaces(
          (stmt as ClassDeclarationNode).name,
        )) {
          relevantInterfaces.add(iface);
        }
      }
      // Temporarily clear metadataOnlyMode so warnAt is not suppressed. The
      // flag is only meaningful for emit() (skipping TAC output) and for the
      // visitor-level diagnostics that fire twice across the two passes; this
      // between-pass site fires exactly once so the guard is inappropriate
      // here. Restore immediately so any later code that checks the flag
      // before resetState() still sees the original value.
      const savedMetadataOnlyMode = this.metadataOnlyMode;
      this.metadataOnlyMode = false;
      try {
        for (const ifaceName of relevantInterfaces) {
          if (
            isAllInlineInterface(this, ifaceName) &&
            !this.interfaceClassIdMap.has(ifaceName)
          ) {
            this.warnAt(
              undefined,
              "AllInlineInterfaceFallback",
              `all-inline interface "${ifaceName}" has no instantiated implementors — for-of loops over this type will fall back to EXTERN dispatch.`,
            );
          }
        }
      } finally {
        this.metadataOnlyMode = savedMetadataOnlyMode;
      }
    }

    const allInstancesFromPass1 = new Map(this.allInlineInstances);
    const interfaceClassIdMapFromPass1 = new Map(
      [...this.interfaceClassIdMap.entries()].map(([k, v]) => [k, new Map(v)]),
    );
    const soaClassesFromPass1 = new Set(this.soaClasses);

    // Pass 2: actual codegen, pre-seeded with pass-1 metadata.
    // resetState() already clears metadataOnlyMode, so no explicit reset here.
    this.resetState();
    this.allInlineInstances = allInstancesFromPass1;
    this.interfaceClassIdMap = interfaceClassIdMapFromPass1;
    this.soaClasses = soaClassesFromPass1;
    return this.convertImpl(program);
  }

  private convertImpl(program: ProgramNode): TACInstruction[] {
    // Pre-register all interface / type-alias types from classRegistry so that
    // late-binding in visitVariableDeclaration can resolve them even when the
    // type alias was defined in a dependency file parsed after the file that
    // uses it (batch-transpiler parse-order issue).
    if (this.classRegistry) {
      for (const iface of this.classRegistry.getAllInterfaces()) {
        if (!this.typeMapper.getAlias(iface.name)) {
          const propertyMap = new Map<string, TypeSymbol>();
          const methodMap = new Map<
            string,
            { params: TypeSymbol[]; returnType: TypeSymbol }
          >();
          for (const prop of iface.node.properties) {
            propertyMap.set(prop.name, prop.type);
          }
          for (const method of iface.node.methods) {
            methodMap.set(method.name, {
              params: method.parameters.map((p) => p.type),
              returnType: method.returnType,
            });
          }
          this.typeMapper.registerTypeAlias(
            iface.name,
            new InterfaceTypeSymbol(iface.name, methodMap, propertyMap),
          );
        }
      }
    }

    // Separate top-level const declarations from other statements
    const topLevelConsts: VariableDeclarationNode[] = [];
    const otherStatements: ASTNode[] = [];
    for (const statement of program.statements) {
      if (
        statement.kind === ASTNodeKind.VariableDeclaration &&
        (statement as VariableDeclarationNode).isConst
      ) {
        topLevelConsts.push(statement as VariableDeclarationNode);
      } else {
        otherStatements.push(statement);
      }
    }

    // Pre-register top-level consts in symbol table;
    // literal consts will be inlined, non-literal consts need runtime init
    for (const tlc of topLevelConsts) {
      if (!this.symbolTable.hasInCurrentScope(tlc.name)) {
        this.symbolTable.addSymbol(
          tlc.name,
          tlc.type,
          false,
          true,
          tlc.initializer,
        );
      } else if (tlc.initializer) {
        // Parser may have already registered the symbol without initializer;
        // update it so that literal inlining in visitIdentifier works
        this.symbolTable.updateInitialValueInCurrentScope(
          tlc.name,
          tlc.initializer,
        );
      }
      if (!tlc.initializer || tlc.initializer.kind !== ASTNodeKind.Literal) {
        this.pendingTopLevelInits.push(tlc);
      }
    }

    for (const statement of otherStatements) {
      if (statement.kind === ASTNodeKind.ClassDeclaration) {
        const classNode = statement as ClassDeclarationNode;
        this.classMap.set(classNode.name, classNode);
        if (
          this.udonBehaviourClasses.has(classNode.name) ||
          classNode.decorators.some((d) => d.name === "UdonBehaviour") ||
          classNode.methods.some(
            (method) =>
              method.name === "Start" ||
              getVrcEventDefinition(method.name) !== undefined,
          )
        ) {
          this.entryPointClasses.add(classNode.name);
        }
      }
    }

    if (this.classRegistry) {
      for (const cls of this.classRegistry.getAllClasses()) {
        if (this.udonBehaviourClasses.has(cls.name)) continue;
        if (this.classRegistry.isStub(cls.name)) continue;
        if (!this.classMap.has(cls.name)) {
          this.classMap.set(cls.name, cls.node);
        }
      }
    }

    // Pre-scan ALL top-level statements (consts + non-class) for native array
    // eligibility BEFORE generating the entry point, so that pendingTopLevelInits
    // processed inside generateEntryPoint already see the correct ineligible set.
    // (Method bodies are scanned inside visitClassMethod before each body.)
    const allTopLevelStatements = [
      ...topLevelConsts,
      ...otherStatements.filter((s) => s.kind !== ASTNodeKind.ClassDeclaration),
    ];
    if (allTopLevelStatements.length > 0) {
      this.nativeArrayIneligible = analyzeNativeArrayIneligibility(
        allTopLevelStatements,
      );
    }

    // Generate entry point _start if a Start method exists
    this.generateEntryPoint(program);

    // Skip standalone code block generation for inline (non-entry-point) classes.
    // Their methods are inlined at call sites via classMap (populated above).
    // When no entry points exist, all classes are processed as a fallback.
    for (const statement of otherStatements) {
      if (statement.kind === ASTNodeKind.ClassDeclaration) {
        const classNode = statement as ClassDeclarationNode;
        if (
          this.entryPointClasses.size > 0 &&
          !this.entryPointClasses.has(classNode.name)
        ) {
          continue;
        }
      }
      this.visitStatement(statement);
    }

    return this.instructions;
  }

  /**
   * Generate _start entry point that jumps to the user's Start method
   */
  generateEntryPoint(program: ProgramNode): void {
    // Check if an entry-point class has a Start method (which will become _start)
    let entryClassHasStart = false;
    for (const stmt of program.statements) {
      if (stmt.kind === ASTNodeKind.ClassDeclaration) {
        const classDecl = stmt as ClassDeclarationNode;
        if (
          this.entryPointClasses.has(classDecl.name) &&
          classDecl.methods.some((m) => m.name === "Start")
        ) {
          entryClassHasStart = true;
          break;
        }
      }
    }

    // If an entry-point class has Start, it will be labeled _start
    // in visitClassDeclaration; non-literal inits are injected there
    if (entryClassHasStart) {
      return;
    }

    // No Start method: generate _start with initialization
    const startLabel = createLabel("_start");
    this.emit(new LabelInstruction(startLabel));

    // 1. pendingTopLevelInits
    for (const tlc of this.pendingTopLevelInits) {
      this.visitStatement(tlc);
    }
    this.pendingTopLevelInits = [];

    // 2. Entry-point class property initialization + constructor body
    for (const [name, classNode] of this.classMap) {
      if (!this.entryPointClasses.has(name)) continue;
      const savedClassName = this.currentClassName;
      this.currentClassName = name;
      try {
        this.emitEntryPointPropertyInit(classNode);
      } finally {
        this.currentClassName = savedClassName;
      }
    }

    this.emit(new ReturnInstruction());
  }

  /**
   * Get generated instructions
   */
  getInstructions(): TACInstruction[] {
    return this.instructions;
  }

  /**
   * Scope an entry-point property name with the current class name
   * when multiple entry-point classes exist, to avoid variable collisions.
   */
  entryPointPropName(propName: string): string {
    if (this.entryPointClasses.size > 1 && this.currentClassName) {
      return `${this.currentClassName}__${propName}`;
    }
    return propName;
  }

  /**
   * Generate a new temporary variable
   */
  newTemp(type: TypeSymbol = PrimitiveTypes.single): TACOperand {
    return createTemporary(this.tempCounter++, type);
  }

  /**
   * Generate a new label
   */
  newLabel(prefix = "L"): TACOperand {
    return createLabel(`${prefix}${this.labelCounter++}`);
  }

  // Bind visitor/helpers to allow splitting across modules
  visitStatement = visitStatement;
  visitVariableDeclaration = visitVariableDeclaration;
  visitIfStatement = visitIfStatement;
  visitWhileStatement = visitWhileStatement;
  visitForStatement = visitForStatement;
  visitForOfStatement = visitForOfStatement;
  visitSwitchStatement = visitSwitchStatement;
  visitDoWhileStatement = visitDoWhileStatement;
  visitBreakStatement = visitBreakStatement;
  visitContinueStatement = visitContinueStatement;
  visitReturnStatement = visitReturnStatement;
  visitBlockStatement = visitBlockStatement;
  visitInlineBlockStatement = visitInlineBlockStatement;
  visitClassDeclaration = visitClassDeclaration;
  visitTryCatchStatement = visitTryCatchStatement;
  visitThrowStatement = visitThrowStatement;
  visitEnumDeclaration = visitEnumDeclaration;
  isDestructureBlock = isDestructureBlock;

  visitExpression = visitExpression;
  visitBinaryExpression = visitBinaryExpression;
  visitShortCircuitAnd = visitShortCircuitAnd;
  visitShortCircuitOr = visitShortCircuitOr;
  visitUnaryExpression = visitUnaryExpression;
  visitConditionalExpression = visitConditionalExpression;
  visitNullCoalescingExpression = visitNullCoalescingExpression;
  visitTemplateExpression = visitTemplateExpression;
  visitArrayLiteralExpression = visitArrayLiteralExpression;
  visitLiteral = visitLiteral;
  visitIdentifier = visitIdentifier;
  visitArrayAccessExpression = visitArrayAccessExpression;
  visitPropertyAccessExpression = visitPropertyAccessExpression;
  visitThisExpression = visitThisExpression;
  visitSuperExpression = visitSuperExpression;
  visitObjectLiteralExpression = visitObjectLiteralExpression;
  visitDeleteExpression = visitDeleteExpression;
  visitOptionalChainingExpression = visitOptionalChainingExpression;
  visitAsExpression = visitAsExpression;
  visitNameofExpression = visitNameofExpression;
  visitTypeofExpression = visitTypeofExpression;

  visitCallExpression = visitCallExpression;
  getUdonTypeConverterTargetType = getUdonTypeConverterTargetType;
  visitObjectStaticCall = visitObjectStaticCall;
  visitNumberStaticCall = visitNumberStaticCall;
  visitMathStaticCall = visitMathStaticCall;
  visitArrayStaticCall = visitArrayStaticCall;
  resolveStaticExtern = resolveStaticExtern;

  assignToTarget = assignToTarget;
  visitAssignmentExpression = visitAssignmentExpression;
  visitUpdateExpression = visitUpdateExpression;
  coerceConstantToType = coerceConstantToType;
  getArrayElementType = getArrayElementType;
  wrapDataToken = wrapDataToken;
  unwrapDataToken = unwrapDataToken;
  getOperandType = getOperandType;
  isNullableType = isNullableType;
  isStatementNode = isStatementNode;

  emitDictionaryFromProperties = emitDictionaryFromProperties;
  emitDataDictionaryKeys = emitDataDictionaryKeys;
  emitDataDictionaryValues = emitDataDictionaryValues;
  emitDataDictionaryEntries = emitDataDictionaryEntries;

  isUdonBehaviourType = isUdonBehaviourType;
  getUdonBehaviourLayout = getUdonBehaviourLayout;
  isUdonBehaviourPropertyAccess = isUdonBehaviourPropertyAccess;
  resolveFieldChangeCallback = resolveFieldChangeCallback;
  emitOnDeserializationForFieldChangeCallbacks =
    emitOnDeserializationForFieldChangeCallbacks;

  allocateBodyCachedInstance = allocateBodyCachedInstance;
  visitInlineConstructor = visitInlineConstructor;
  visitInlineStaticMethodCall = visitInlineStaticMethodCall;
  visitInlineInstanceMethodCall = visitInlineInstanceMethodCall;
  visitInlineInstanceMethodCallWithContext =
    visitInlineInstanceMethodCallWithContext;
  maybeTrackInlineInstanceAssignment = maybeTrackInlineInstanceAssignment;
  emitCopyWithTracking = emitCopyWithTracking;
  emitEntryPointPropertyInit = emitEntryPointPropertyInit;
  mapInlineProperty = mapInlineProperty;
  mapStaticProperty = mapStaticProperty;
  resolveInlineInstance = resolveInlineInstance;
  tryResolveUnitySelfReference = tryResolveUnitySelfReference;
  collectRecursiveLocals = collectRecursiveLocals;
  emitCallSitePush = emitCallSitePush;
  emitCallSitePop = emitCallSitePop;
  emitInlineRecursivePush = emitInlineRecursivePush;
  emitInlineRecursivePop = emitInlineRecursivePop;
  emitReturnSiteDispatch = emitReturnSiteDispatch;

  emitTryInstructionsWithChecks = emitTryInstructionsWithChecks;
  getCheckOperand = getCheckOperand;

  mergeTemplateParts = mergeTemplateParts;
  tryFoldTemplateExpression = tryFoldTemplateExpression;
  templateLiteralValueToString = templateLiteralValueToString;

  coerceSwitchOperand = coerceSwitchOperand;
  coerceToBoolean = coerceToBoolean;
  isSwitchComparableType = isSwitchComparableType;

  requireExternSignature = requireExternSignature;
}

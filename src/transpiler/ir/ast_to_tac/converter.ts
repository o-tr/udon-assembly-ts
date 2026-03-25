/**
 * Convert AST to TAC (Three-Address Code)
 */

import type { ClassRegistry } from "../../frontend/class_registry.js";
import { EnumRegistry } from "../../frontend/enum_registry.js";
import type { SymbolTable } from "../../frontend/symbol_table.js";
import { TypeMapper } from "../../frontend/type_mapper.js";
import type { TypeSymbol } from "../../frontend/type_symbols.js";
import { PrimitiveTypes } from "../../frontend/type_symbols.js";
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
import {
  emitDataDictionaryEntries,
  emitDataDictionaryKeys,
  emitDataDictionaryValues,
  emitDictionaryFromProperties,
} from "./helpers/data_dictionary.js";
import { requireExternSignature } from "./helpers/extern.js";
import {
  collectRecursiveLocals,
  emitCallSitePop,
  emitCallSitePush,
  emitEntryPointPropertyInit,
  emitReturnSiteDispatch,
  mapInlineProperty,
  maybeTrackInlineInstanceAssignment,
  resolveInlineInstance,
  tryResolveUnitySelfReference,
  visitInlineConstructor,
  visitInlineInstanceMethodCall,
  visitInlineInstanceMethodCallWithContext,
  visitInlineStaticMethodCall,
} from "./helpers/inline.js";
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
  tempCounter = 0;
  labelCounter = 0;
  instanceCounter = 0;
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
  }> = [];
  currentThisOverride: TACOperand | null = null;
  propertyAccessDepth = 0;
  typeMapper: TypeMapper;
  enumRegistry: EnumRegistry;
  classMap: Map<string, ClassDeclarationNode> = new Map();
  entryPointClasses: Set<string> = new Set();
  inlineInstanceMap: Map<string, { prefix: string; className: string }> =
    new Map();
  inlineMethodStack: Set<string> = new Set();
  /** Maps interface name → (class name → classId) for inline dispatch */
  interfaceClassIdMap: Map<string, Map<string, number>> = new Map();
  /** Maps instanceId → {prefix, className} for all inline instances */
  allInlineInstances: Map<number, { prefix: string; className: string }> =
    new Map();
  nextInstanceId = 0;
  /** Cache for isAllInlineInterface results to avoid O(N) rescans */
  allInlineInterfaceCache: Map<string, boolean> = new Map();
  udonBehaviourClasses: Set<string>;
  udonBehaviourLayouts: UdonBehaviourLayouts;
  classRegistry: ClassRegistry | null;
  currentParamExportMap: Map<string, string> = new Map();
  currentParamExportReverseMap: Map<string, string> = new Map();
  currentMethodLayout: UdonBehaviourMethodLayout | null = null;
  inSerializeFieldInitializer = false;
  pendingTopLevelInits: VariableDeclarationNode[] = [];
  currentExpectedType: TypeSymbol | undefined = undefined;

  constructor(
    symbolTable: SymbolTable,
    enumRegistry?: EnumRegistry,
    udonBehaviourClasses?: Set<string>,
    udonBehaviourLayouts?: UdonBehaviourLayouts,
    classRegistry?: ClassRegistry,
    options?: { useStringBuilder?: boolean; stringBuilderThreshold?: number },
  ) {
    this.symbolTable = symbolTable;
    this.enumRegistry = enumRegistry ?? new EnumRegistry();
    this.typeMapper = new TypeMapper(this.enumRegistry);
    this.udonBehaviourClasses = udonBehaviourClasses ?? new Set();
    this.udonBehaviourLayouts = udonBehaviourLayouts ?? new Map();
    this.classRegistry = classRegistry ?? null;
    this.useStringBuilder = options?.useStringBuilder !== false;
    this.stringBuilderThreshold =
      options?.stringBuilderThreshold ?? this.stringBuilderThreshold;
  }

  /**
   * Scan for variable declarations in a block and pre-register them
   */
  scanDeclarations(statements: ASTNode[]): void {
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
   * Convert program to TAC
   */
  convert(program: ProgramNode): TACInstruction[] {
    this.instructions = [];
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.instanceCounter = 0;
    this.classMap = new Map();
    this.entryPointClasses = new Set();
    this.inlineInstanceMap = new Map();
    this.inlineMethodStack = new Set();
    this.interfaceClassIdMap = new Map();
    this.allInlineInstances = new Map();
    this.allInlineInterfaceCache = new Map();
    this.nextInstanceId = 0;
    this.pendingTopLevelInits = [];
    this.currentExpectedType = undefined;
    this.recursiveReturnSites = new Map();
    this.currentParamExportMap = new Map();
    this.currentParamExportReverseMap = new Map();

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
    this.instructions.push(new LabelInstruction(startLabel));

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

    this.instructions.push(new ReturnInstruction());
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

  visitInlineConstructor = visitInlineConstructor;
  visitInlineStaticMethodCall = visitInlineStaticMethodCall;
  visitInlineInstanceMethodCall = visitInlineInstanceMethodCall;
  visitInlineInstanceMethodCallWithContext =
    visitInlineInstanceMethodCallWithContext;
  maybeTrackInlineInstanceAssignment = maybeTrackInlineInstanceAssignment;
  emitEntryPointPropertyInit = emitEntryPointPropertyInit;
  mapInlineProperty = mapInlineProperty;
  resolveInlineInstance = resolveInlineInstance;
  tryResolveUnitySelfReference = tryResolveUnitySelfReference;
  collectRecursiveLocals = collectRecursiveLocals;
  emitCallSitePush = emitCallSitePush;
  emitCallSitePop = emitCallSitePop;
  emitReturnSiteDispatch = emitReturnSiteDispatch;

  emitTryInstructionsWithChecks = emitTryInstructionsWithChecks;
  getCheckOperand = getCheckOperand;

  mergeTemplateParts = mergeTemplateParts;
  tryFoldTemplateExpression = tryFoldTemplateExpression;
  templateLiteralValueToString = templateLiteralValueToString;

  coerceSwitchOperand = coerceSwitchOperand;
  isSwitchComparableType = isSwitchComparableType;

  requireExternSignature = requireExternSignature;
}

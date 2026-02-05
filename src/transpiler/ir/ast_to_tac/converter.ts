/**
 * Convert AST to TAC (Three-Address Code)
 */

import { resolveExternSignature } from "../../codegen/extern_signatures.js";
import {
  computeTypeId,
  typeMetadataRegistry,
} from "../../codegen/type_metadata_registry.js";
import { EnumRegistry } from "../../frontend/enum_registry.js";
import type { SymbolTable } from "../../frontend/symbol_table.js";
import { isTsOnlyCallExpression } from "../../frontend/ts_only.js";
import { TypeMapper } from "../../frontend/type_mapper.js";
import type { TypeSymbol } from "../../frontend/type_symbols.js";
import {
  ArrayTypeSymbol,
  CollectionTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  ObjectType,
  PrimitiveTypes,
} from "../../frontend/type_symbols.js";
import {
  type ArrayAccessExpressionNode,
  type ArrayLiteralExpressionNode,
  type ASTNode,
  ASTNodeKind,
  type AsExpressionNode,
  type AssignmentExpressionNode,
  type BinaryExpressionNode,
  type BlockStatementNode,
  type BreakStatementNode,
  type CallExpressionNode,
  type ClassDeclarationNode,
  type ConditionalExpressionNode,
  type ContinueStatementNode,
  type DeleteExpressionNode,
  type DoWhileStatementNode,
  type EnumDeclarationNode,
  type ForOfStatementNode,
  type ForStatementNode,
  type IdentifierNode,
  type IfStatementNode,
  type LiteralNode,
  type NameofExpressionNode,
  type NullCoalescingExpressionNode,
  type ObjectLiteralExpressionNode,
  type ObjectLiteralPropertyNode,
  type OptionalChainingExpressionNode,
  type ProgramNode,
  type PropertyAccessExpressionNode,
  type ReturnStatementNode,
  type SuperExpressionNode,
  type SwitchStatementNode,
  type TemplateExpressionNode,
  type TemplatePart,
  type ThisExpressionNode,
  type ThrowStatementNode,
  type TryCatchStatementNode,
  type TypeofExpressionNode,
  UdonType,
  type UnaryExpressionNode,
  type UpdateExpressionNode,
  type VariableDeclarationNode,
  type WhileStatementNode,
} from "../../frontend/types.js";
import { getVrcEventDefinition } from "../../vrc/event_registry.js";
import {
  ArrayAccessInstruction,
  ArrayAssignmentInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  CastInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  PropertySetInstruction,
  ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnaryOpInstruction,
  UnconditionalJumpInstruction,
} from "../tac_instruction.js";
import {
  type ConstantOperand,
  createConstant,
  createLabel,
  createTemporary,
  createVariable,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
} from "../tac_operand.js";
import type {
  UdonBehaviourClassLayout,
  UdonBehaviourLayouts,
  UdonBehaviourMethodLayout,
} from "../udon_behaviour_layout.js";
import {
  visitStatement,
  visitVariableDeclaration,
  visitIfStatement,
  visitWhileStatement,
  visitForStatement,
  visitForOfStatement,
  visitSwitchStatement,
  visitDoWhileStatement,
  visitBreakStatement,
  visitContinueStatement,
  visitReturnStatement,
  visitBlockStatement,
  visitInlineBlockStatement,
  visitClassDeclaration,
  visitTryCatchStatement,
  visitThrowStatement,
  visitEnumDeclaration,
  isDestructureBlock,
} from "./visitors/statement.js";
import {
  visitExpression,
  visitBinaryExpression,
  visitShortCircuitAnd,
  visitShortCircuitOr,
  visitUnaryExpression,
  visitConditionalExpression,
  visitNullCoalescingExpression,
  visitTemplateExpression,
  visitArrayLiteralExpression,
  visitLiteral,
  visitIdentifier,
  visitArrayAccessExpression,
  visitPropertyAccessExpression,
  visitThisExpression,
  visitSuperExpression,
  visitObjectLiteralExpression,
  visitDeleteExpression,
  visitOptionalChainingExpression,
  visitAsExpression,
  visitNameofExpression,
  visitTypeofExpression,
} from "./visitors/expression.js";
import {
  visitCallExpression,
  getUdonTypeConverterTargetType,
  visitObjectStaticCall,
  visitNumberStaticCall,
  visitMathStaticCall,
  visitArrayStaticCall,
  resolveStaticExtern,
} from "./visitors/call.js";
import {
  assignToTarget,
  visitAssignmentExpression,
  visitUpdateExpression,
  coerceConstantToType,
  getArrayElementType,
  wrapDataToken,
  getOperandType,
  isNullableType,
  isStatementNode,
} from "./helpers/assignment.js";
import {
  emitDictionaryFromProperties,
  emitDataDictionaryKeys,
  emitDataDictionaryValues,
  emitDataDictionaryEntries,
} from "./helpers/data_dictionary.js";
import {
  isUdonBehaviourType,
  getUdonBehaviourLayout,
  isUdonBehaviourPropertyAccess,
  resolveFieldChangeCallback,
  emitOnDeserializationForFieldChangeCallbacks,
} from "./helpers/udon_behaviour.js";
import {
  visitInlineConstructor,
  visitInlineStaticMethodCall,
  maybeTrackInlineInstanceAssignment,
  mapInlineProperty,
  tryResolveUnitySelfReference,
  collectRecursiveLocals,
  emitRecursivePrologue,
  emitRecursiveEpilogue,
} from "./helpers/inline.js";
import {
  emitTryInstructionsWithChecks,
  getCheckOperand,
} from "./helpers/try_catch.js";
import {
  mergeTemplateParts,
  tryFoldTemplateExpression,
  templateLiteralValueToString,
} from "./helpers/template.js";
import { coerceSwitchOperand, isSwitchComparableType } from "./helpers/switch.js";
import { requireExternSignature } from "./helpers/extern.js";

/**
 * AST to TAC converter
 */
export class ASTToTACConverter {
  instructions: TACInstruction[] = [];
  tempCounter = 0;
  labelCounter = 0;
  instanceCounter = 0;
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
        stackVars: Array<{ name: string; type: TypeSymbol }>;
      }
    | undefined;
  loopContextStack: Array<{
    breakLabel: TACOperand;
    continueLabel: TACOperand;
  }> = [];
  tryCounter = 0;
  tryContextStack: Array<{
    errorFlag: VariableOperand;
    errorValue: VariableOperand;
    errorTarget: TACOperand;
  }> = [];
  inlineReturnStack: Array<{
    returnVar: TACOperand;
    returnLabel: TACOperand;
  }> = [];
  propertyAccessDepth = 0;
  typeMapper: TypeMapper;
  enumRegistry: EnumRegistry;
  classMap: Map<string, ClassDeclarationNode> = new Map();
  entryPointClasses: Set<string> = new Set();
  inlineInstanceMap: Map<string, { prefix: string; className: string }> =
    new Map();
  inlineStaticMethodStack: Set<string> = new Set();
  udonBehaviourClasses: Set<string>;
  udonBehaviourLayouts: UdonBehaviourLayouts;
  currentParamExportMap: Map<string, string> = new Map();
  currentMethodLayout: UdonBehaviourMethodLayout | null = null;
  inSerializeFieldInitializer = false;

  constructor(
    symbolTable: SymbolTable,
    enumRegistry?: EnumRegistry,
    udonBehaviourClasses?: Set<string>,
    udonBehaviourLayouts?: UdonBehaviourLayouts,
  ) {
    this.symbolTable = symbolTable;
    this.enumRegistry = enumRegistry ?? new EnumRegistry();
    this.typeMapper = new TypeMapper(this.enumRegistry);
    this.udonBehaviourClasses = udonBehaviourClasses ?? new Set();
    this.udonBehaviourLayouts = udonBehaviourLayouts ?? new Map();
  }

  /**
   * Scan for variable declarations in a block and pre-register them
   */
  scanDeclarations(statements: ASTNode[]): void {
    for (const stmt of statements) {
      if (stmt.kind === ASTNodeKind.VariableDeclaration) {
        const node = stmt as VariableDeclarationNode;
        if (!this.symbolTable.hasInCurrentScope(node.name)) {
          this.symbolTable.addSymbol(node.name, node.type, false, node.isConst);
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

    for (const statement of program.statements) {
      if (statement.kind === ASTNodeKind.ClassDeclaration) {
        const classNode = statement as ClassDeclarationNode;
        this.classMap.set(classNode.name, classNode);
        if (
          classNode.methods.some(
            (method) =>
              method.name === "Start" ||
              getVrcEventDefinition(method.name) !== null,
          )
        ) {
          this.entryPointClasses.add(classNode.name);
        }
      }
    }

    // Generate entry point _start if a Start method exists
    this.generateEntryPoint(program);

    for (const statement of program.statements) {
      this.visitStatement(statement);
    }

    return this.instructions;
  }

  /**
   * Generate _start entry point that jumps to the user's Start method
   */
  generateEntryPoint(program: ProgramNode): void {
    let startMethodLabel: string | undefined;

    for (const stmt of program.statements) {
      if (stmt.kind === ASTNodeKind.ClassDeclaration) {
        const classDecl = stmt as ClassDeclarationNode;
        const startMethod = classDecl.methods.find((m) => m.name === "Start");
        if (startMethod) {
          startMethodLabel = `__Start_${classDecl.name}`;
          break;
        }
      }
    }

    // If Start method exists, it will act as _start directly
    if (startMethodLabel) {
      return;
    }

    // Always generate _start label to safely handle initialization,
    // If not, just return (no-op start).
    // This ensures _start event is valid.
    const startLabel = createLabel("_start");
    this.instructions.push(new LabelInstruction(startLabel));
    this.instructions.push(new ReturnInstruction());
  }

  /**
   * Get generated instructions
   */
  getInstructions(): TACInstruction[] {
    return this.instructions;
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
  maybeTrackInlineInstanceAssignment = maybeTrackInlineInstanceAssignment;
  mapInlineProperty = mapInlineProperty;
  tryResolveUnitySelfReference = tryResolveUnitySelfReference;
  collectRecursiveLocals = collectRecursiveLocals;
  emitRecursivePrologue = emitRecursivePrologue;
  emitRecursiveEpilogue = emitRecursiveEpilogue;

  emitTryInstructionsWithChecks = emitTryInstructionsWithChecks;
  getCheckOperand = getCheckOperand;

  mergeTemplateParts = mergeTemplateParts;
  tryFoldTemplateExpression = tryFoldTemplateExpression;
  templateLiteralValueToString = templateLiteralValueToString;

  coerceSwitchOperand = coerceSwitchOperand;
  isSwitchComparableType = isSwitchComparableType;

  requireExternSignature = requireExternSignature;
}

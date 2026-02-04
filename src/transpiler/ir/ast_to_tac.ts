/**
 * Convert AST to TAC (Three-Address Code)
 */

import { resolveExternSignature } from "../codegen/extern_signatures.js";
import { computeTypeId } from "../codegen/type_metadata_registry.js";
import {
  generateExternSignature,
  mapTypeScriptToCSharp,
} from "../codegen/udon_type_resolver.js";
import { EnumRegistry } from "../frontend/enum_registry.js";
import type { SymbolTable } from "../frontend/symbol_table.js";
import { isTsOnlyCallExpression } from "../frontend/ts_only.js";
import { TypeMapper } from "../frontend/type_mapper.js";
import type { TypeSymbol } from "../frontend/type_symbols.js";
import {
  ArrayTypeSymbol,
  CollectionTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  ObjectType,
  PrimitiveTypes,
} from "../frontend/type_symbols.js";
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
} from "../frontend/types.js";
import { getVrcEventDefinition } from "../vrc/event_registry.js";
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
} from "./tac_instruction.js";
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
} from "./tac_operand.js";
import type {
  UdonBehaviourClassLayout,
  UdonBehaviourLayouts,
  UdonBehaviourMethodLayout,
} from "./udon_behaviour_layout.js";

/**
 * AST to TAC converter
 */
export class ASTToTACConverter {
  private instructions: TACInstruction[] = [];
  private tempCounter = 0;
  private labelCounter = 0;
  private instanceCounter = 0;
  private symbolTable: SymbolTable;
  private currentReturnVar: string | undefined;
  private currentClassName: string | undefined;
  private currentMethodName: string | undefined;
  private currentInlineContext:
    | { className: string; instancePrefix: string }
    | undefined;
  private currentRecursiveContext:
    | {
        locals: Array<{ name: string; type: TypeSymbol }>;
        depthVar: string;
        stackVars: Array<{ name: string; type: TypeSymbol }>;
      }
    | undefined;
  private loopContextStack: Array<{
    breakLabel: TACOperand;
    continueLabel: TACOperand;
  }> = [];
  private tryCounter = 0;
  private tryContextStack: Array<{
    errorFlag: VariableOperand;
    errorValue: VariableOperand;
    errorTarget: TACOperand;
  }> = [];
  private inlineReturnStack: Array<{
    returnVar: TACOperand;
    returnLabel: TACOperand;
  }> = [];
  private propertyAccessDepth = 0;
  private typeMapper: TypeMapper;
  private enumRegistry: EnumRegistry;
  private classMap: Map<string, ClassDeclarationNode> = new Map();
  private entryPointClasses: Set<string> = new Set();
  private inlineInstanceMap: Map<
    string,
    { prefix: string; className: string }
  > = new Map();
  private inlineStaticMethodStack: Set<string> = new Set();
  private udonBehaviourClasses: Set<string>;
  private udonBehaviourLayouts: UdonBehaviourLayouts;
  private currentParamExportMap: Map<string, string> = new Map();
  private currentMethodLayout: UdonBehaviourMethodLayout | null = null;
  private inSerializeFieldInitializer = false;

  private isUdonBehaviourType(type: TypeSymbol | undefined): boolean {
    if (!type) return false;
    const classNode = this.classMap.get(type.name);
    if (classNode) {
      return classNode.decorators.some(
        (decorator) => decorator.name === "UdonBehaviour",
      );
    }
    return this.udonBehaviourClasses.has(type.name);
  }

  private getUdonBehaviourLayout(
    className: string,
  ): UdonBehaviourClassLayout | null {
    return this.udonBehaviourLayouts.get(className) ?? null;
  }

  private isUdonBehaviourPropertyAccess(
    propAccess: PropertyAccessExpressionNode,
  ): boolean {
    if (propAccess.object.kind === ASTNodeKind.Identifier) {
      const name = (propAccess.object as IdentifierNode).name;
      const symbol = this.symbolTable.lookup(name);
      return !!symbol && this.isUdonBehaviourType(symbol.type);
    }

    if (propAccess.object.kind === ASTNodeKind.PropertyAccessExpression) {
      const inner = propAccess.object as PropertyAccessExpressionNode;
      if (inner.object.kind === ASTNodeKind.ThisExpression) {
        const symbol = this.symbolTable.lookup(inner.property);
        if (symbol && this.isUdonBehaviourType(symbol.type)) {
          return true;
        }
        if (this.currentClassName) {
          const classNode = this.classMap.get(this.currentClassName);
          const prop = classNode?.properties.find(
            (p) => p.name === inner.property,
          );
          if (prop && this.isUdonBehaviourType(prop.type)) {
            return true;
          }
        }
        return false;
      }
    }

    return false;
  }

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
  private scanDeclarations(statements: ASTNode[]): void {
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

    // Ensure program ends with stop to prevent fallthrough from last method (safety)
    // Removed to match standard UASM output which relies on method flow control
    // this.instructions.push(
    //   new UnconditionalJumpInstruction(createLabel("_stop_program")),
    // );
    // this.instructions.push(new LabelInstruction(createLabel("_stop_program")));
    // this.instructions.push(new ReturnInstruction());

    return this.instructions;
  }

  /**
   * Generate _start entry point that jumps to the user's Start method
   */
  private generateEntryPoint(program: ProgramNode): void {
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
  private newTemp(type: TypeSymbol = PrimitiveTypes.single): TACOperand {
    return createTemporary(this.tempCounter++, type);
  }

  /**
   * Generate a new label
   */
  private newLabel(prefix = "L"): TACOperand {
    return createLabel(`${prefix}${this.labelCounter++}`);
  }

  /**
   * Visit statement
   */
  private visitStatement(node: ASTNode): void {
    switch (node.kind) {
      case ASTNodeKind.VariableDeclaration:
        this.visitVariableDeclaration(node as VariableDeclarationNode);
        break;
      case ASTNodeKind.IfStatement:
        this.visitIfStatement(node as IfStatementNode);
        break;
      case ASTNodeKind.WhileStatement:
        this.visitWhileStatement(node as WhileStatementNode);
        break;
      case ASTNodeKind.SwitchStatement:
        this.visitSwitchStatement(node as SwitchStatementNode);
        break;
      case ASTNodeKind.DoWhileStatement:
        this.visitDoWhileStatement(node as DoWhileStatementNode);
        break;
      case ASTNodeKind.ForOfStatement:
        this.visitForOfStatement(node as ForOfStatementNode);
        break;
      case ASTNodeKind.BreakStatement:
        this.visitBreakStatement(node as BreakStatementNode);
        break;
      case ASTNodeKind.ContinueStatement:
        this.visitContinueStatement(node as ContinueStatementNode);
        break;
      case ASTNodeKind.ReturnStatement:
        this.visitReturnStatement(node as ReturnStatementNode);
        break;
      case ASTNodeKind.BlockStatement:
        if (this.isDestructureBlock(node as BlockStatementNode)) {
          this.visitInlineBlockStatement(node as BlockStatementNode);
        } else {
          this.visitBlockStatement(node as BlockStatementNode);
        }
        break;
      case ASTNodeKind.ForStatement:
        this.visitForStatement(node as ForStatementNode);
        break;
      case ASTNodeKind.EnumDeclaration:
        this.visitEnumDeclaration(node as EnumDeclarationNode);
        break;
      case ASTNodeKind.ClassDeclaration:
        this.visitClassDeclaration(node as ClassDeclarationNode);
        break;
      case ASTNodeKind.TryCatchStatement:
        this.visitTryCatchStatement(node as TryCatchStatementNode);
        break;
      case ASTNodeKind.ThrowStatement:
        this.visitThrowStatement(node as ThrowStatementNode);
        break;
      case ASTNodeKind.AssignmentExpression:
        this.visitExpression(node);
        break;
      case ASTNodeKind.CallExpression:
        this.visitExpression(node);
        break;
    }
  }

  /**
   * Visit variable declaration
   */
  private visitVariableDeclaration(node: VariableDeclarationNode): void {
    const dest = createVariable(node.name, node.type, { isLocal: true });

    if (!this.symbolTable.hasInCurrentScope(node.name)) {
      this.symbolTable.addSymbol(node.name, node.type, false, node.isConst);
    }

    if (node.initializer) {
      const src = this.visitExpression(node.initializer);
      this.instructions.push(new AssignmentInstruction(dest, src));
      this.maybeTrackInlineInstanceAssignment(dest, src);
    }
  }

  /**
   * Visit if statement
   */
  private visitIfStatement(node: IfStatementNode): void {
    const condition = this.visitExpression(node.condition);
    const elseLabel = this.newLabel("else");
    const endLabel = this.newLabel("endif");

    // Invert condition for jump to else
    const notCondition = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new UnaryOpInstruction(notCondition, "!", condition),
    );
    this.instructions.push(
      new ConditionalJumpInstruction(notCondition, elseLabel),
    );

    // Then branch
    this.visitStatement(node.thenBranch);
    this.instructions.push(new UnconditionalJumpInstruction(endLabel));

    // Else branch
    this.instructions.push(new LabelInstruction(elseLabel));
    if (node.elseBranch) {
      this.visitStatement(node.elseBranch);
    }

    // End label
    this.instructions.push(new LabelInstruction(endLabel));
  }

  /**
   * Visit while statement
   */
  private visitWhileStatement(node: WhileStatementNode): void {
    const startLabel = this.newLabel("while_start");
    const endLabel = this.newLabel("while_end");

    // Start label
    this.instructions.push(new LabelInstruction(startLabel));

    // Condition
    const condition = this.visitExpression(node.condition);
    const notCondition = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new UnaryOpInstruction(notCondition, "!", condition),
    );
    this.instructions.push(
      new ConditionalJumpInstruction(notCondition, endLabel),
    );

    // Body
    this.loopContextStack.push({
      breakLabel: endLabel,
      continueLabel: startLabel,
    });
    this.visitStatement(node.body);
    this.loopContextStack.pop();

    // Jump back to start
    this.instructions.push(new UnconditionalJumpInstruction(startLabel));

    // End label
    this.instructions.push(new LabelInstruction(endLabel));
  }

  /**
   * Visit for statement
   */
  private visitForStatement(node: ForStatementNode): void {
    if (node.initializer) {
      if (this.isStatementNode(node.initializer)) {
        this.visitStatement(node.initializer);
      } else {
        this.visitExpression(node.initializer);
      }
    }

    const startLabel = this.newLabel("for_start");
    const endLabel = this.newLabel("for_end");

    this.instructions.push(new LabelInstruction(startLabel));

    if (node.condition) {
      const condition = this.visitExpression(node.condition);
      const notCondition = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(
        new UnaryOpInstruction(notCondition, "!", condition),
      );
      this.instructions.push(
        new ConditionalJumpInstruction(notCondition, endLabel),
      );
    }

    const continueLabel = this.newLabel("for_continue");
    this.loopContextStack.push({
      breakLabel: endLabel,
      continueLabel,
    });
    this.visitStatement(node.body);
    this.loopContextStack.pop();

    this.instructions.push(new LabelInstruction(continueLabel));
    if (node.incrementor) {
      this.visitExpression(node.incrementor);
    }

    this.instructions.push(new UnconditionalJumpInstruction(startLabel));
    this.instructions.push(new LabelInstruction(endLabel));
  }

  /**
   * Visit for-of statement
   */
  private visitForOfStatement(node: ForOfStatementNode): void {
    const iterableOperand = this.visitExpression(node.iterable);
    const indexVar = this.newTemp(PrimitiveTypes.int32);
    const lengthVar = this.newTemp(PrimitiveTypes.int32);

    const isDestructured = Array.isArray(node.variable);
    const isObjectDestructured = !!node.destructureProperties?.length;
    const elementType = isDestructured
      ? ExternTypes.dataList
      : isObjectDestructured
        ? ObjectType
        : (this.getArrayElementType(iterableOperand) ??
          (node.variableType
            ? this.typeMapper.mapTypeScriptType(node.variableType)
            : PrimitiveTypes.single));

    let elementVar: TACOperand;
    if (isDestructured) {
      elementVar = this.newTemp(elementType);
    } else {
      const variableName = node.variable as string;
      if (!this.symbolTable.hasInCurrentScope(variableName)) {
        this.symbolTable.addSymbol(variableName, elementType, false, false);
      }
      elementVar = createVariable(variableName, elementType, { isLocal: true });
    }

    this.instructions.push(
      new AssignmentInstruction(
        indexVar,
        createConstant(0, PrimitiveTypes.int32),
      ),
    );
    this.instructions.push(
      new PropertyGetInstruction(
        lengthVar,
        iterableOperand,
        this.getOperandType(iterableOperand).name === ExternTypes.dataList.name
          ? "Count"
          : "length",
      ),
    );

    const loopStart = this.newLabel("forof_start");
    const loopContinue = this.newLabel("forof_continue");
    const loopEnd = this.newLabel("forof_end");

    this.loopContextStack.push({
      breakLabel: loopEnd,
      continueLabel: loopContinue,
    });

    this.instructions.push(new LabelInstruction(loopStart));
    const condTemp = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
    );
    const notCond = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(new UnaryOpInstruction(notCond, "!", condTemp));
    this.instructions.push(new ConditionalJumpInstruction(notCond, loopEnd));

    this.instructions.push(
      new ArrayAccessInstruction(elementVar, iterableOperand, indexVar),
    );
    if (isDestructured) {
      const names = node.variable as string[];
      for (let i = 0; i < names.length; i += 1) {
        const name = names[i];
        if (!this.symbolTable.hasInCurrentScope(name)) {
          this.symbolTable.addSymbol(name, ObjectType, false, false);
        }
        const targetVar = createVariable(name, ObjectType, { isLocal: true });
        const elementValue = this.newTemp(ObjectType);
        this.instructions.push(
          new MethodCallInstruction(elementValue, elementVar, "get_Item", [
            createConstant(i, PrimitiveTypes.int32),
          ]),
        );
        this.instructions.push(new CopyInstruction(targetVar, elementValue));
      }
    }
    if (isObjectDestructured && node.destructureProperties) {
      for (const entry of node.destructureProperties) {
        if (!this.symbolTable.hasInCurrentScope(entry.name)) {
          this.symbolTable.addSymbol(entry.name, ObjectType, false, false);
        }
        const targetVar = createVariable(entry.name, ObjectType, {
          isLocal: true,
        });
        const propValue = this.newTemp(ObjectType);
        this.instructions.push(
          new PropertyGetInstruction(propValue, elementVar, entry.property),
        );
        this.instructions.push(new CopyInstruction(targetVar, propValue));
      }
    }
    this.visitStatement(node.body);

    this.instructions.push(new LabelInstruction(loopContinue));
    this.instructions.push(
      new BinaryOpInstruction(
        indexVar,
        indexVar,
        "+",
        createConstant(1, PrimitiveTypes.int32),
      ),
    );
    this.instructions.push(new UnconditionalJumpInstruction(loopStart));
    this.instructions.push(new LabelInstruction(loopEnd));

    this.loopContextStack.pop();
  }

  private visitSwitchStatement(node: SwitchStatementNode): void {
    const endLabel = this.newLabel("switch_end");
    const switchValue = this.visitExpression(node.expression);
    const switchType = this.getOperandType(switchValue);
    const switchTemp = this.newTemp(switchType);
    this.instructions.push(new CopyInstruction(switchTemp, switchValue));
    const caseEntries = node.cases.map((caseNode) => ({
      node: caseNode,
      label: this.newLabel("switch_case"),
    }));

    for (const entry of caseEntries) {
      if (!entry.node.expression) continue;
      const rawCaseValue = this.visitExpression(entry.node.expression);
      const caseValue = this.coerceSwitchOperand(rawCaseValue, switchType);
      const comparisonResult = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(
        new BinaryOpInstruction(comparisonResult, switchTemp, "==", caseValue),
      );
      this.instructions.push(
        new ConditionalJumpInstruction(comparisonResult, entry.label),
      );
    }

    const defaultEntry = caseEntries.find(
      (entry) => entry.node.expression === null,
    );
    this.instructions.push(
      new UnconditionalJumpInstruction(defaultEntry?.label ?? endLabel),
    );

    this.loopContextStack.push({
      breakLabel: endLabel,
      continueLabel: endLabel,
    });

    for (const entry of caseEntries) {
      this.instructions.push(new LabelInstruction(entry.label));
      for (const statement of entry.node.statements) {
        this.visitStatement(statement);
      }
    }

    this.loopContextStack.pop();
    this.instructions.push(new LabelInstruction(endLabel));
  }

  private visitDoWhileStatement(node: DoWhileStatementNode): void {
    const startLabel = this.newLabel("do_start");
    const conditionLabel = this.newLabel("do_condition");
    const endLabel = this.newLabel("do_end");

    this.instructions.push(new LabelInstruction(startLabel));

    this.loopContextStack.push({
      breakLabel: endLabel,
      continueLabel: conditionLabel,
    });
    this.visitStatement(node.body);
    this.loopContextStack.pop();

    this.instructions.push(new LabelInstruction(conditionLabel));
    const condition = this.visitExpression(node.condition);
    const notCondition = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new UnaryOpInstruction(notCondition, "!", condition),
    );
    this.instructions.push(
      new ConditionalJumpInstruction(notCondition, endLabel),
    );
    this.instructions.push(new UnconditionalJumpInstruction(startLabel));
    this.instructions.push(new LabelInstruction(endLabel));
  }

  private visitBreakStatement(_node: BreakStatementNode): void {
    const context = this.loopContextStack[this.loopContextStack.length - 1];
    if (!context) {
      throw new Error("Break statement used outside of loop or switch");
    }
    this.instructions.push(
      new UnconditionalJumpInstruction(context.breakLabel),
    );
  }

  private visitContinueStatement(_node: ContinueStatementNode): void {
    const context = this.loopContextStack[this.loopContextStack.length - 1];
    if (!context) {
      throw new Error("Continue statement used outside of loop");
    }
    this.instructions.push(
      new UnconditionalJumpInstruction(context.continueLabel),
    );
  }

  private visitReturnStatement(node: ReturnStatementNode): void {
    if (this.currentRecursiveContext) {
      const valueOperand = node.value
        ? this.visitExpression(node.value)
        : undefined;
      const tempValue = valueOperand
        ? this.newTemp(this.getOperandType(valueOperand))
        : undefined;
      if (tempValue && valueOperand) {
        this.instructions.push(new CopyInstruction(tempValue, valueOperand));
      }
      this.emitRecursiveEpilogue();
      this.instructions.push(
        new ReturnInstruction(tempValue, this.currentReturnVar),
      );
      return;
    }
    const inlineContext =
      this.inlineReturnStack[this.inlineReturnStack.length - 1];
    if (inlineContext) {
      if (node.value) {
        const value = this.visitExpression(node.value);
        this.instructions.push(
          new CopyInstruction(inlineContext.returnVar, value),
        );
      }
      this.instructions.push(
        new UnconditionalJumpInstruction(inlineContext.returnLabel),
      );
      return;
    }
    const value = node.value ? this.visitExpression(node.value) : undefined;
    this.instructions.push(new ReturnInstruction(value, this.currentReturnVar));
  }

  /**
   * Visit block statement
   */
  private visitBlockStatement(node: BlockStatementNode): void {
    this.symbolTable.enterScope();
    this.scanDeclarations(node.statements);
    for (const statement of node.statements) {
      this.visitStatement(statement);
    }
    this.symbolTable.exitScope();
  }

  private visitInlineBlockStatement(node: BlockStatementNode): void {
    for (const statement of node.statements) {
      this.visitStatement(statement);
    }
  }

  private isDestructureBlock(node: BlockStatementNode): boolean {
    if (node.statements.length === 0) return false;
    if (
      !node.statements.every(
        (stmt) => stmt.kind === ASTNodeKind.VariableDeclaration,
      )
    ) {
      return false;
    }
    const first = node.statements[0] as VariableDeclarationNode;
    return first.name.startsWith("__destructure_");
  }

  /**
   * Visit class declaration (flatten method bodies for now)
   */
  private visitClassDeclaration(node: ClassDeclarationNode): void {
    this.currentClassName = node.name;
    const classLayout = this.getUdonBehaviourLayout(node.name);
    const isUdonBehaviourClass =
      classLayout !== null ||
      node.decorators.some((decorator) => decorator.name === "UdonBehaviour");
    for (const method of node.methods) {
      this.currentMethodName = method.name;
      const eventDef = getVrcEventDefinition(method.name);
      let labelName = eventDef
        ? eventDef.udonName
        : `__${method.name}_${node.name}`;
      if (method.name === "Start") {
        labelName = "_start";
      }
      if (isUdonBehaviourClass && method.name !== "Start") {
        const layout = classLayout?.get(method.name) ?? null;
        if (layout) {
          labelName = layout.exportMethodName;
          this.currentMethodLayout = layout;
        } else {
          this.currentMethodLayout = null;
        }
      } else {
        this.currentMethodLayout = null;
      }
      const label = createLabel(labelName);
      this.instructions.push(new LabelInstruction(label));

      if (this.currentMethodLayout?.returnExportName) {
        this.currentReturnVar = this.currentMethodLayout.returnExportName;
      } else {
        this.currentReturnVar = "__returnValue_return";
      }
      this.symbolTable.enterScope();
      this.currentParamExportMap = new Map();
      let recursionContext:
        | {
            locals: Array<{ name: string; type: TypeSymbol }>;
            depthVar: string;
            stackVars: Array<{ name: string; type: TypeSymbol }>;
          }
        | undefined;
      if (eventDef) {
        for (const param of eventDef.parameters) {
          if (!this.symbolTable.hasInCurrentScope(param.name)) {
            this.symbolTable.addSymbol(
              param.name,
              this.typeMapper.mapUdonType(param.type),
              true,
              false,
            );
          }
        }
      }
      for (const param of method.parameters) {
        if (!this.symbolTable.hasInCurrentScope(param.name)) {
          this.symbolTable.addSymbol(param.name, param.type, true, false);
        }
      }
      if (this.currentMethodLayout) {
        for (let i = 0; i < method.parameters.length; i++) {
          const paramName = method.parameters[i]?.name;
          const exportName = this.currentMethodLayout.parameterExportNames[i];
          if (paramName && exportName) {
            this.currentParamExportMap.set(paramName, exportName);
          }
        }
      }

      if (method.isRecursive) {
        const locals = this.collectRecursiveLocals(method);
        const depthVar = `__recursionDepth_${method.name}`;
        const stackVars = locals.map((local) => ({
          name: `__recursionStack_${method.name}_${local.name}`,
          type: new ArrayTypeSymbol(local.type),
        }));

        recursionContext = { locals, depthVar, stackVars };
        this.currentRecursiveContext = recursionContext;
        this.emitRecursivePrologue();
      }

      this.visitBlockStatement(method.body);
      if (this.currentRecursiveContext) {
        this.emitRecursiveEpilogue();
      }
      this.instructions.push(
        new ReturnInstruction(undefined, this.currentReturnVar),
      );
      this.symbolTable.exitScope();
      this.currentReturnVar = undefined;
      this.currentRecursiveContext = undefined;
      this.currentMethodName = undefined;
      this.currentParamExportMap = new Map();
      this.currentMethodLayout = null;
    }

    const hasOnDeserialization = node.methods.some(
      (method) => method.name === "OnDeserialization",
    );
    if (!hasOnDeserialization) {
      this.emitOnDeserializationForFieldChangeCallbacks(node);
    }
    this.currentClassName = undefined;
  }

  /**
   * Visit expression and return the operand containing the result
   */
  private visitExpression(node: ASTNode): TACOperand {
    switch (node.kind) {
      case ASTNodeKind.BinaryExpression:
        return this.visitBinaryExpression(node as BinaryExpressionNode);
      case ASTNodeKind.UnaryExpression:
        return this.visitUnaryExpression(node as UnaryExpressionNode);
      case ASTNodeKind.UpdateExpression:
        return this.visitUpdateExpression(node as UpdateExpressionNode);
      case ASTNodeKind.ConditionalExpression:
        return this.visitConditionalExpression(
          node as ConditionalExpressionNode,
        );
      case ASTNodeKind.NullCoalescingExpression:
        return this.visitNullCoalescingExpression(
          node as NullCoalescingExpressionNode,
        );
      case ASTNodeKind.NameofExpression:
        return this.visitNameofExpression(node as NameofExpressionNode);
      case ASTNodeKind.TypeofExpression:
        return this.visitTypeofExpression(node as TypeofExpressionNode);
      case ASTNodeKind.OptionalChainingExpression:
        return this.visitOptionalChainingExpression(
          node as OptionalChainingExpressionNode,
        );
      case ASTNodeKind.TemplateExpression:
        return this.visitTemplateExpression(node as TemplateExpressionNode);
      case ASTNodeKind.ArrayLiteralExpression:
        return this.visitArrayLiteralExpression(
          node as ArrayLiteralExpressionNode,
        );
      case ASTNodeKind.Literal:
        return this.visitLiteral(node as LiteralNode);
      case ASTNodeKind.Identifier:
        return this.visitIdentifier(node as IdentifierNode);
      case ASTNodeKind.ObjectLiteralExpression:
        return this.visitObjectLiteralExpression(
          node as ObjectLiteralExpressionNode,
        );
      case ASTNodeKind.DeleteExpression:
        return this.visitDeleteExpression(node as DeleteExpressionNode);
      case ASTNodeKind.SuperExpression:
        return this.visitSuperExpression(node as SuperExpressionNode);
      case ASTNodeKind.CallExpression:
        return this.visitCallExpression(node as CallExpressionNode);
      case ASTNodeKind.AsExpression:
        return this.visitAsExpression(node as AsExpressionNode);
      case ASTNodeKind.AssignmentExpression:
        return this.visitAssignmentExpression(node as AssignmentExpressionNode);
      case ASTNodeKind.PropertyAccessExpression:
        return this.visitPropertyAccessExpression(
          node as PropertyAccessExpressionNode,
        );
      case ASTNodeKind.ArrayAccessExpression:
        return this.visitArrayAccessExpression(
          node as ArrayAccessExpressionNode,
        );
      case ASTNodeKind.ThisExpression:
        return this.visitThisExpression(node as ThisExpressionNode);
      default:
        throw new Error(`Unsupported expression kind: ${node.kind}`);
    }
  }

  /**
   * Visit binary expression
   */
  private visitBinaryExpression(node: BinaryExpressionNode): TACOperand {
    if (node.operator === "===") {
      node = { ...node, operator: "==" };
    } else if (node.operator === "!==") {
      node = { ...node, operator: "!=" };
    }
    const compoundOps: Record<string, string> = {
      "+=": "+",
      "-=": "-",
      "*=": "*",
      "/=": "/",
      "%=": "%",
      "&=": "&",
      "|=": "|",
      "^=": "^",
    };
    if (compoundOps[node.operator]) {
      const left = this.visitExpression(node.left);
      const right = this.visitExpression(node.right);
      const resultType = this.getOperandType(left);
      const newValue = this.newTemp(resultType);
      this.instructions.push(
        new BinaryOpInstruction(
          newValue,
          left,
          compoundOps[node.operator],
          right,
        ),
      );
      return this.assignToTarget(node.left, newValue);
    }
    if (node.operator === "**") {
      const left = this.visitExpression(node.left);
      const right = this.visitExpression(node.right);
      const result = this.newTemp(PrimitiveTypes.single);
      const externSig = this.resolveStaticExtern("Mathf", "Pow", "method");
      if (!externSig) {
        throw new Error("Mathf.Pow extern signature not found");
      }
      this.instructions.push(
        new CallInstruction(result, externSig, [left, right]),
      );
      return result;
    }
    if (node.operator === "instanceof") {
      return createConstant(false, PrimitiveTypes.boolean);
    }
    if (node.operator === "in") {
      const key = this.visitExpression(node.left);
      const target = this.visitExpression(node.right);
      const targetType = this.getOperandType(target);
      if (targetType.name === ExternTypes.dataDictionary.name) {
        const result = this.newTemp(PrimitiveTypes.boolean);
        const keyToken = this.wrapDataToken(key);
        this.instructions.push(
          new MethodCallInstruction(result, target, "ContainsKey", [keyToken]),
        );
        return result;
      }
      return createConstant(false, PrimitiveTypes.boolean);
    }
    if (node.operator === ">>>") {
      return this.visitExpression(node.left);
    }
    if (node.operator === "&&") {
      return this.visitShortCircuitAnd(node);
    }
    if (node.operator === "||") {
      return this.visitShortCircuitOr(node);
    }
    const left = this.visitExpression(node.left);
    const right = this.visitExpression(node.right);

    // Determine result type - comparison operators return Boolean
    const isComparison = ["<", ">", "<=", ">=", "==", "!="].includes(
      node.operator,
    );
    const resultType = isComparison
      ? PrimitiveTypes.boolean
      : this.getOperandType(left);
    const result = this.newTemp(resultType);

    this.instructions.push(
      new BinaryOpInstruction(result, left, node.operator, right),
    );
    return result;
  }

  private visitShortCircuitAnd(node: BinaryExpressionNode): TACOperand {
    const result = this.newTemp(PrimitiveTypes.boolean);
    const shortCircuitLabel = this.newLabel("and_short");
    const endLabel = this.newLabel("and_end");

    const left = this.visitExpression(node.left);
    const notLeft = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(new UnaryOpInstruction(notLeft, "!", left));
    this.instructions.push(
      new ConditionalJumpInstruction(notLeft, shortCircuitLabel),
    );

    const right = this.visitExpression(node.right);
    this.instructions.push(new CopyInstruction(result, right));
    this.instructions.push(new UnconditionalJumpInstruction(endLabel));

    this.instructions.push(new LabelInstruction(shortCircuitLabel));
    this.instructions.push(
      new AssignmentInstruction(
        result,
        createConstant(false, PrimitiveTypes.boolean),
      ),
    );
    this.instructions.push(new LabelInstruction(endLabel));
    return result;
  }

  private visitShortCircuitOr(node: BinaryExpressionNode): TACOperand {
    const result = this.newTemp(PrimitiveTypes.boolean);
    const shortCircuitLabel = this.newLabel("or_short");
    const endLabel = this.newLabel("or_end");

    const left = this.visitExpression(node.left);
    const notLeft = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(new UnaryOpInstruction(notLeft, "!", left));
    this.instructions.push(
      new ConditionalJumpInstruction(notLeft, shortCircuitLabel),
    );

    this.instructions.push(
      new AssignmentInstruction(
        result,
        createConstant(true, PrimitiveTypes.boolean),
      ),
    );
    this.instructions.push(new UnconditionalJumpInstruction(endLabel));

    this.instructions.push(new LabelInstruction(shortCircuitLabel));
    const right = this.visitExpression(node.right);
    this.instructions.push(new CopyInstruction(result, right));
    this.instructions.push(new LabelInstruction(endLabel));
    return result;
  }

  /**
   * Visit unary expression
   */
  private visitUnaryExpression(node: UnaryExpressionNode): TACOperand {
    const operand = this.visitExpression(node.operand);
    const resultType = this.getOperandType(operand);
    const result = this.newTemp(resultType);

    this.instructions.push(
      new UnaryOpInstruction(result, node.operator, operand),
    );
    return result;
  }

  private visitConditionalExpression(
    node: ConditionalExpressionNode,
  ): TACOperand {
    const condition = this.visitExpression(node.condition);
    const falseLabel = this.newLabel("cond_false");
    const endLabel = this.newLabel("cond_end");

    const notCondition = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new UnaryOpInstruction(notCondition, "!", condition),
    );
    this.instructions.push(
      new ConditionalJumpInstruction(notCondition, falseLabel),
    );

    const trueVal = this.visitExpression(node.whenTrue);
    const result = this.newTemp(this.getOperandType(trueVal));
    this.instructions.push(new CopyInstruction(result, trueVal));
    this.instructions.push(new UnconditionalJumpInstruction(endLabel));

    this.instructions.push(new LabelInstruction(falseLabel));
    const falseVal = this.visitExpression(node.whenFalse);
    this.instructions.push(new CopyInstruction(result, falseVal));
    this.instructions.push(new LabelInstruction(endLabel));
    return result;
  }

  private visitNullCoalescingExpression(
    node: NullCoalescingExpressionNode,
  ): TACOperand {
    const left = this.visitExpression(node.left);
    const result = this.newTemp(this.getOperandType(left));
    const useDefaultLabel = this.newLabel("null_default");
    const endLabel = this.newLabel("null_end");

    const isNull = this.newTemp(PrimitiveTypes.boolean);
    const nullConstant = createConstant(null, ObjectType);
    this.instructions.push(
      new BinaryOpInstruction(isNull, left, "==", nullConstant),
    );
    // Jump to default branch when left IS null
    this.instructions.push(
      new ConditionalJumpInstruction(isNull, useDefaultLabel),
    );

    // left not null -> result = left
    this.instructions.push(new CopyInstruction(result, left));
    this.instructions.push(new UnconditionalJumpInstruction(endLabel));

    this.instructions.push(new LabelInstruction(useDefaultLabel));
    const right = this.visitExpression(node.right);
    this.instructions.push(new CopyInstruction(result, right));
    this.instructions.push(new LabelInstruction(endLabel));
    return result;
  }

  private visitTemplateExpression(node: TemplateExpressionNode): TACOperand {
    const mergedParts = this.mergeTemplateParts(node.parts);
    const folded = this.tryFoldTemplateExpression(mergedParts);
    if (folded) {
      return folded;
    }
    let result: TACOperand | null = null;
    for (const part of mergedParts) {
      let partOperand: TACOperand;
      if (part.kind === "text") {
        if (part.value.length === 0) {
          continue;
        }
        partOperand = createConstant(part.value, PrimitiveTypes.string);
      } else {
        const exprResult = this.visitExpression(part.expression);
        const exprType = this.getOperandType(exprResult);
        if (exprType.udonType === UdonType.String) {
          partOperand = exprResult;
        } else {
          partOperand = this.newTemp(PrimitiveTypes.string);
          this.instructions.push(
            new MethodCallInstruction(partOperand, exprResult, "ToString", []),
          );
        }
      }

      if (!result) {
        result = partOperand;
        continue;
      }

      const newResult = this.newTemp(PrimitiveTypes.string);
      const concatExtern =
        "SystemString.__Concat__SystemString_SystemString__SystemString";
      this.instructions.push(
        new CallInstruction(newResult, concatExtern, [result, partOperand]),
      );
      result = newResult;
    }
    return result ?? createConstant("", PrimitiveTypes.string);
  }

  private visitArrayLiteralExpression(
    node: ArrayLiteralExpressionNode,
  ): TACOperand {
    const elementType = node.typeHint
      ? this.typeMapper.mapTypeScriptType(node.typeHint)
      : ObjectType;
    const listResult = this.newTemp(new DataListTypeSymbol(elementType));
    const externSig = "VRCSDKBaseDataList.__ctor____VRCSDKBaseDataList";
    this.instructions.push(new CallInstruction(listResult, externSig, []));

    for (const element of node.elements) {
      if (element.kind === "spread") {
        // TODO: support spread elements by concatenating arrays/lists instead of ignoring them.
        this.visitExpression(element.value);
        continue;
      }
      const value = this.visitExpression(element.value);
      const token = this.wrapDataToken(value);
      this.instructions.push(
        new MethodCallInstruction(undefined, listResult, "Add", [token]),
      );
    }

    return listResult;
  }

  /**
   * Visit literal
   */
  private visitLiteral(node: LiteralNode): TACOperand {
    return createConstant(node.value, node.type);
  }

  /**
   * Visit identifier
   */
  private visitIdentifier(node: IdentifierNode): TACOperand {
    if (node.name === "undefined") {
      return createConstant(null, ObjectType);
    }
    const symbol = this.symbolTable.lookup(node.name);
    if (!symbol) {
      if (
        this.classMap.has(node.name) ||
        node.name === "UdonTypeConverters" ||
        node.name === "Object" ||
        node.name === "Number" ||
        node.name === "BigInt" ||
        node.name === "Math" ||
        node.name === "Array" ||
        node.name === "Error" ||
        node.name === "console" ||
        node.name === "process" ||
        node.name === "Date" ||
        node.name === "JSON"
      ) {
        return createVariable(node.name, ObjectType);
      }
      const location = this.currentClassName
        ? `${this.currentClassName}${this.currentMethodName ? `.${this.currentMethodName}` : ""}`
        : "<unknown>";
      throw new Error(`Undefined variable: ${node.name} in ${location}`);
    }
    const exportName = this.currentParamExportMap.get(node.name);
    const isParameter = symbol.isParameter === true;
    const isExported = !!exportName;
    const isLocal = !isParameter && (symbol.scope ?? 0) > 0;
    const variableName = exportName ?? node.name;
    return createVariable(variableName, symbol.type, {
      isLocal,
      isParameter,
      isExported,
    });
  }

  private visitArrayAccessExpression(
    node: ArrayAccessExpressionNode,
  ): TACOperand {
    const array = this.visitExpression(node.array);
    const index = this.visitExpression(node.index);
    const arrayType = this.getOperandType(array);
    if (arrayType instanceof CollectionTypeSymbol) {
      const elementType =
        arrayType.valueType ?? arrayType.elementType ?? PrimitiveTypes.single;
      const result = this.newTemp(elementType);
      this.instructions.push(
        new MethodCallInstruction(result, array, "get_Item", [index]),
      );
      return result;
    }

    if (
      arrayType instanceof DataListTypeSymbol ||
      arrayType.name === ExternTypes.dataList.name
    ) {
      const elementType =
        arrayType instanceof DataListTypeSymbol
          ? arrayType.elementType
          : ObjectType;
      const result = this.newTemp(elementType);
      this.instructions.push(
        new MethodCallInstruction(result, array, "get_Item", [index]),
      );
      return result;
    }

    const elementType =
      this.getArrayElementType(array) ?? PrimitiveTypes.single;
    const result = this.newTemp(elementType);
    this.instructions.push(new ArrayAccessInstruction(result, array, index));
    return result;
  }

  /**
   * Visit property access expression
   */
  private visitPropertyAccessExpression(
    node: PropertyAccessExpressionNode,
  ): TACOperand {
    this.propertyAccessDepth += 1;
    if (this.propertyAccessDepth > 200) {
      throw new Error(
        `Property access recursion too deep at ${node.property} (${node.object.kind})`,
      );
    }
    try {
      if (
        node.object.kind === ASTNodeKind.Identifier &&
        this.enumRegistry.isEnum((node.object as IdentifierNode).name)
      ) {
        const enumName = (node.object as IdentifierNode).name;
        const value = this.enumRegistry.resolve(enumName, node.property);
        if (value !== undefined) {
          const kind = this.enumRegistry.getEnumKind(enumName);
          const type =
            kind === "string" ? PrimitiveTypes.string : PrimitiveTypes.int32;
          return createConstant(value, type);
        }
      }

      if (
        node.object.kind === ASTNodeKind.Identifier &&
        (node.object as IdentifierNode).name === "Number"
      ) {
        if (node.property === "NEGATIVE_INFINITY") {
          return createConstant(-3.4028235e38, PrimitiveTypes.single);
        }
        if (node.property === "POSITIVE_INFINITY") {
          return createConstant(3.4028235e38, PrimitiveTypes.single);
        }
      }

      const selfRef = this.tryResolveUnitySelfReference(node);
      if (selfRef) return selfRef;

      if (
        node.object.kind === ASTNodeKind.ThisExpression &&
        this.currentInlineContext
      ) {
        const mapped = this.mapInlineProperty(
          this.currentInlineContext.className,
          this.currentInlineContext.instancePrefix,
          node.property,
        );
        if (mapped) return mapped;
      }

      if (node.object.kind === ASTNodeKind.Identifier) {
        const instanceInfo = this.inlineInstanceMap.get(
          (node.object as IdentifierNode).name,
        );
        if (instanceInfo) {
          const mapped = this.mapInlineProperty(
            instanceInfo.className,
            instanceInfo.prefix,
            node.property,
          );
          if (mapped) return mapped;
        }
      }

      if (node.object.kind === ASTNodeKind.Identifier) {
        const objectName = (node.object as IdentifierNode).name;
        const externSig = this.resolveStaticExtern(
          objectName,
          node.property,
          "getter",
        );
        if (externSig) {
          const result = this.newTemp(PrimitiveTypes.single);
          this.instructions.push(new CallInstruction(result, externSig, []));
          return result;
        }
      }

      if (node.object.kind === ASTNodeKind.PropertyAccessExpression) {
        const access = node.object as PropertyAccessExpressionNode;
        if (
          access.object.kind === ASTNodeKind.Identifier &&
          (access.object as IdentifierNode).name === "process" &&
          access.property === "env" &&
          node.property === "NODE_ENV"
        ) {
          return createConstant("production", PrimitiveTypes.string);
        }
      }

      const object = this.visitExpression(node.object);
      let resultType: TypeSymbol | undefined;
      if (
        node.object.kind === ASTNodeKind.ThisExpression &&
        this.currentClassName
      ) {
        const classNode = this.classMap.get(this.currentClassName);
        const prop = classNode?.properties.find(
          (p) => p.name === node.property,
        );
        if (prop) resultType = prop.type;
      }
      const result = this.newTemp(resultType ?? PrimitiveTypes.single);
      this.instructions.push(
        new PropertyGetInstruction(result, object, node.property),
      );
      return result;
    } finally {
      this.propertyAccessDepth -= 1;
    }
  }

  /**
   * Visit this expression
   */
  private visitThisExpression(_node: ThisExpressionNode): TACOperand {
    return createVariable("this", ObjectType);
  }

  /**
   * Visit super expression
   */
  private visitSuperExpression(_node: SuperExpressionNode): TACOperand {
    return createVariable("this", ObjectType);
  }

  /**
   * Visit object literal expression
   */
  private visitObjectLiteralExpression(
    node: ObjectLiteralExpressionNode,
  ): TACOperand {
    const hasSpread = node.properties.some((prop) => prop.kind === "spread");
    if (!hasSpread) {
      return this.emitDictionaryFromProperties(node.properties);
    }

    const listResult = this.newTemp(ExternTypes.dataList);
    const listCtorSig = "VRCSDKBaseDataList.__ctor____VRCSDKBaseDataList";
    this.instructions.push(new CallInstruction(listResult, listCtorSig, []));

    let pendingProps: ObjectLiteralPropertyNode[] = [];
    const flushPending = (): void => {
      if (pendingProps.length === 0) return;
      const dictSegment = this.emitDictionaryFromProperties(pendingProps);
      const dictToken = this.wrapDataToken(dictSegment);
      this.instructions.push(
        new MethodCallInstruction(undefined, listResult, "Add", [dictToken]),
      );
      pendingProps = [];
    };

    for (const prop of node.properties) {
      if (prop.kind === "spread") {
        flushPending();
        const spreadValue = this.visitExpression(prop.value);
        const spreadToken = this.wrapDataToken(spreadValue);
        this.instructions.push(
          new MethodCallInstruction(undefined, listResult, "Add", [
            spreadToken,
          ]),
        );
        continue;
      }
      pendingProps.push(prop);
    }
    flushPending();

    const mergeResult = this.newTemp(ExternTypes.dataDictionary);
    this.instructions.push(
      new CallInstruction(mergeResult, "DataDictionaryHelpers.Merge", [
        listResult,
      ]),
    );
    return mergeResult;
  }

  private emitDictionaryFromProperties(
    properties: ObjectLiteralPropertyNode[],
  ): TACOperand {
    const dictResult = this.newTemp(ExternTypes.dataDictionary);
    const dictCtorSig =
      "VRCSDKBaseDataDictionary.__ctor____VRCSDKBaseDataDictionary";
    this.instructions.push(new CallInstruction(dictResult, dictCtorSig, []));

    for (const prop of properties) {
      if (prop.kind !== "property") continue;
      const keyToken = this.wrapDataToken(
        createConstant(prop.key, PrimitiveTypes.string),
      );
      const value = this.visitExpression(prop.value);
      const valueToken = this.wrapDataToken(value);
      this.instructions.push(
        new MethodCallInstruction(undefined, dictResult, "SetValue", [
          keyToken,
          valueToken,
        ]),
      );
    }

    return dictResult;
  }

  private visitDeleteExpression(node: DeleteExpressionNode): TACOperand {
    if (node.target.kind === ASTNodeKind.PropertyAccessExpression) {
      const propAccess = node.target as PropertyAccessExpressionNode;
      const object = this.visitExpression(propAccess.object);
      if (this.isUdonBehaviourPropertyAccess(propAccess)) {
        const externSig =
          "VRCUdonCommonInterfacesIUdonEventReceiver.__SetProgramVariable__SystemString_SystemObject__SystemVoid";
        const propName = createConstant(
          propAccess.property,
          PrimitiveTypes.string,
        );
        const nullValue = createConstant(null, ObjectType);
        this.instructions.push(
          new CallInstruction(undefined, externSig, [
            object,
            propName,
            nullValue,
          ]),
        );
        return createConstant(true, PrimitiveTypes.boolean);
      }
      const objectType = this.getOperandType(object);
      if (objectType.name === ExternTypes.dataDictionary.name) {
        const keyToken = this.wrapDataToken(
          createConstant(propAccess.property, PrimitiveTypes.string),
        );
        const result = this.newTemp(PrimitiveTypes.boolean);
        this.instructions.push(
          new MethodCallInstruction(result, object, "Remove", [keyToken]),
        );
        return result;
      }
      const nullValue = createConstant(null, ObjectType);
      this.instructions.push(
        new PropertySetInstruction(object, propAccess.property, nullValue),
      );
      return createConstant(true, PrimitiveTypes.boolean);
    }

    if (node.target.kind === ASTNodeKind.ArrayAccessExpression) {
      const arrayAccess = node.target as ArrayAccessExpressionNode;
      const array = this.visitExpression(arrayAccess.array);
      const index = this.visitExpression(arrayAccess.index);
      const objectType = this.getOperandType(array);
      if (objectType.name === ExternTypes.dataDictionary.name) {
        const keyToken = this.wrapDataToken(index);
        const result = this.newTemp(PrimitiveTypes.boolean);
        this.instructions.push(
          new MethodCallInstruction(result, array, "Remove", [keyToken]),
        );
        return result;
      }
      const nullValue = createConstant(null, ObjectType);
      this.instructions.push(
        new ArrayAssignmentInstruction(array, index, nullValue),
      );
      return createConstant(true, PrimitiveTypes.boolean);
    }

    this.visitExpression(node.target);
    return createConstant(true, PrimitiveTypes.boolean);
  }

  /**
   * Visit call expression
   */
  private visitCallExpression(node: CallExpressionNode): TACOperand {
    const callee = node.callee;
    if (isTsOnlyCallExpression(node)) {
      return createConstant(null, ObjectType);
    }

    const args = node.arguments.map((arg) => this.visitExpression(arg));
    const result = this.newTemp(PrimitiveTypes.single);
    if (callee.kind === ASTNodeKind.Identifier) {
      const calleeName = (callee as IdentifierNode).name;
      if (calleeName === "Error") {
        return args[0] ?? createConstant("Error", PrimitiveTypes.string);
      }
      if (calleeName === "BigInt") {
        if (args.length !== 1) {
          throw new Error("BigInt(...) expects one argument.");
        }
        const arg = args[0] ?? createConstant(0, PrimitiveTypes.single);
        const argType = this.getOperandType(arg);
        if (
          argType.udonType === UdonType.Int64 ||
          argType.udonType === UdonType.UInt64
        ) {
          return arg;
        }
        const castResult = this.newTemp(PrimitiveTypes.int64);
        this.instructions.push(new CastInstruction(castResult, arg));
        return castResult;
      }
      if (node.isNew && this.classMap.has(calleeName)) {
        return this.visitInlineConstructor(calleeName, args);
      }
      if (
        node.isNew &&
        (calleeName === "UdonList" ||
          calleeName === "UdonDictionary" ||
          calleeName === "UdonQueue" ||
          calleeName === "UdonStack" ||
          calleeName === "UdonHashSet")
      ) {
        const typeArgText = node.typeArguments?.length
          ? `${calleeName}<${node.typeArguments.join(", ")}>`
          : calleeName;
        const collectionType = this.typeMapper.mapTypeScriptType(typeArgText);
        const collectionResult = this.newTemp(collectionType);
        const externSig =
          resolveExternSignature(calleeName, "ctor", "method") ??
          `${calleeName}()`;
        this.instructions.push(
          new CallInstruction(collectionResult, externSig, args),
        );
        return collectionResult;
      }
      if (node.isNew && calleeName === "DataList") {
        const listResult = this.newTemp(ExternTypes.dataList);
        const externSig = "VRCSDKBaseDataList.__ctor____VRCSDKBaseDataList";
        this.instructions.push(new CallInstruction(listResult, externSig, []));
        return listResult;
      }
      if (node.isNew && calleeName === "DataDictionary") {
        const dictResult = this.newTemp(ExternTypes.dataDictionary);
        const externSig =
          "VRCSDKBaseDataDictionary.__ctor____VRCSDKBaseDataDictionary";
        this.instructions.push(new CallInstruction(dictResult, externSig, []));
        return dictResult;
      }
      if (node.isNew && calleeName === "Array" && args.length > 0) {
        const arrayType = node.typeArguments?.[0]
          ? this.typeMapper.mapTypeScriptType(node.typeArguments[0])
          : ObjectType;
        const listResult = this.newTemp(new DataListTypeSymbol(arrayType));
        const externSig = "VRCSDKBaseDataList.__ctor____VRCSDKBaseDataList";
        this.instructions.push(new CallInstruction(listResult, externSig, []));
        for (const arg of args) {
          const token = this.wrapDataToken(arg);
          this.instructions.push(
            new MethodCallInstruction(undefined, listResult, "Add", [token]),
          );
        }
        return listResult;
      }
      if (
        (calleeName === "Instantiate" || calleeName === "VRCInstantiate") &&
        args.length === 1
      ) {
        const instResult = this.newTemp(ExternTypes.gameObject);
        const externSig =
          "VRCInstantiate.__Instantiate__UnityEngineGameObject__UnityEngineGameObject";
        this.instructions.push(
          new CallInstruction(instResult, externSig, args),
        );
        return instResult;
      }
      if (node.isNew && (calleeName === "Vector3" || calleeName === "Color")) {
        const externSig = `__ctor_${calleeName}`;
        this.instructions.push(new CallInstruction(result, externSig, args));
        return result;
      }
      this.instructions.push(new CallInstruction(result, calleeName, args));
      return result;
    }

    if (callee.kind === ASTNodeKind.PropertyAccessExpression) {
      const propAccess = callee as PropertyAccessExpressionNode;

      if (
        propAccess.object.kind === ASTNodeKind.Identifier &&
        (propAccess.object as IdentifierNode).name === "UdonTypeConverters"
      ) {
        if (args.length !== 1) {
          throw new Error(
            `UdonTypeConverters.${propAccess.property} expects 1 argument`,
          );
        }
        const targetType = this.getUdonTypeConverterTargetType(
          propAccess.property,
        );
        if (!targetType) {
          throw new Error(
            `Unsupported UdonTypeConverters method: ${propAccess.property}`,
          );
        }
        const castResult = this.newTemp(targetType);
        this.instructions.push(new CastInstruction(castResult, args[0]));
        return castResult;
      }

      if (
        propAccess.object.kind === ASTNodeKind.Identifier &&
        (propAccess.object as IdentifierNode).name === "BigInt"
      ) {
        if (propAccess.property === "asUintN") {
          if (args.length !== 2) {
            throw new Error("BigInt.asUintN expects two arguments.");
          }
          return args[1] ?? createConstant(0, PrimitiveTypes.single);
        }
      }

      if (
        propAccess.object.kind === ASTNodeKind.Identifier &&
        (propAccess.object as IdentifierNode).name === "Object"
      ) {
        const objectResult = this.visitObjectStaticCall(
          propAccess.property,
          args,
        );
        if (objectResult) return objectResult;
      }

      if (
        propAccess.object.kind === ASTNodeKind.Identifier &&
        (propAccess.object as IdentifierNode).name === "Number"
      ) {
        const numberResult = this.visitNumberStaticCall(
          propAccess.property,
          args,
        );
        if (numberResult) return numberResult;
      }

      if (
        propAccess.object.kind === ASTNodeKind.Identifier &&
        (propAccess.object as IdentifierNode).name === "Math"
      ) {
        const mathResult = this.visitMathStaticCall(propAccess.property, args);
        if (mathResult) return mathResult;
      }

      if (
        propAccess.object.kind === ASTNodeKind.Identifier &&
        (propAccess.object as IdentifierNode).name === "Array"
      ) {
        const arrayResult = this.visitArrayStaticCall(
          propAccess.property,
          args,
        );
        if (arrayResult) return arrayResult;
      }

      if (
        propAccess.object.kind === ASTNodeKind.Identifier &&
        (propAccess.object as IdentifierNode).name === "Date" &&
        propAccess.property === "now"
      ) {
        return createConstant(0, PrimitiveTypes.single);
      }

      if (
        propAccess.object.kind === ASTNodeKind.Identifier &&
        (propAccess.object as IdentifierNode).name === "JSON"
      ) {
        if (propAccess.property === "stringify") {
          return createConstant("{}", PrimitiveTypes.string);
        }
        if (propAccess.property === "parse") {
          return createConstant(null, ObjectType);
        }
      }

      if (propAccess.object.kind === ASTNodeKind.Identifier) {
        const className = (propAccess.object as IdentifierNode).name;
        const inlineResult = this.visitInlineStaticMethodCall(
          className,
          propAccess.property,
          args,
        );
        if (inlineResult) return inlineResult;
      }

      if (
        propAccess.object.kind === ASTNodeKind.Identifier &&
        this.resolveStaticExtern(
          (propAccess.object as IdentifierNode).name,
          propAccess.property,
          "method",
        )
      ) {
        const externSig = this.resolveStaticExtern(
          (propAccess.object as IdentifierNode).name,
          propAccess.property,
          "method",
        );
        if (externSig) {
          this.instructions.push(new CallInstruction(result, externSig, args));
          return result;
        }
      }

      // Handle console.log/error/warn
      if (
        propAccess.object.kind === ASTNodeKind.Identifier &&
        (propAccess.object as IdentifierNode).name === "console"
      ) {
        let externName = "";
        switch (propAccess.property) {
          case "log":
          case "info":
            externName = "UnityEngineDebug.__Log__SystemObject__SystemVoid";
            break;
          case "error":
            externName =
              "UnityEngineDebug.__LogError__SystemObject__SystemVoid";
            break;
          case "warn":
            externName =
              "UnityEngineDebug.__LogWarning__SystemObject__SystemVoid";
            break;
        }

        if (externName) {
          this.instructions.push(
            new CallInstruction(undefined, externName, args),
          );
          return createConstant(0, PrimitiveTypes.void); // Console methods return void
        }
      }

      if (
        propAccess.property === "length" &&
        propAccess.object.kind === ASTNodeKind.Identifier
      ) {
        const array = this.visitExpression(propAccess.object);
        const lengthResult = this.newTemp(PrimitiveTypes.int32);
        const arrayType = this.getOperandType(array);
        const lengthProp =
          arrayType.name === ExternTypes.dataList.name ? "Count" : "length";
        this.instructions.push(
          new PropertyGetInstruction(lengthResult, array, lengthProp),
        );
        return lengthResult;
      }

      const object = this.visitExpression(propAccess.object);
      if (
        propAccess.property === "GetComponent" &&
        node.typeArguments?.length === 1
      ) {
        const targetType = node.typeArguments[0] ?? "object";
        const targetTypeSymbol = this.typeMapper.mapTypeScriptType(targetType);
        const typeId = computeTypeId(targetType);
        const typeOperand = createConstant(
          `0x${typeId.toString(16)}`,
          PrimitiveTypes.int64,
        );
        const externSig =
          "UdonSharpLibInternalGetComponentShim.__GetComponent__UnityEngineComponent_SystemInt64__UnityEngineComponent";
        const typeResult = this.newTemp(targetTypeSymbol);
        this.instructions.push(
          new CallInstruction(typeResult, externSig, [object, typeOperand]),
        );
        return typeResult;
      }
      if (
        propAccess.property === "SendCustomEvent" &&
        args.length === 1 &&
        args[0].kind === TACOperandKind.Constant
      ) {
        const _methodName = (args[0] as ConstantOperand).value as string;
        const externSig =
          "VRCUdonCommonInterfacesIUdonEventReceiver.__SendCustomEvent__SystemString__SystemVoid";
        this.instructions.push(
          new CallInstruction(undefined, externSig, [object, args[0]]),
        );
        return createConstant(0, PrimitiveTypes.void);
      }
      if (
        propAccess.property === "SendCustomNetworkEvent" &&
        args.length === 2
      ) {
        const externSig =
          "VRCUdonCommonInterfacesIUdonEventReceiver.__SendCustomNetworkEvent__VRCUdonCommonEnumsNetworkEventTarget_SystemString__SystemVoid";
        this.instructions.push(
          new CallInstruction(undefined, externSig, [object, args[0], args[1]]),
        );
        return createConstant(0, PrimitiveTypes.void);
      }
      const objectType = this.getOperandType(object);
      if (this.isUdonBehaviourType(objectType)) {
        const layout = this.getUdonBehaviourLayout(objectType.name)?.get(
          propAccess.property,
        );
        const methodName = createConstant(
          layout?.exportMethodName ?? propAccess.property,
          PrimitiveTypes.string,
        );
        if (layout) {
          const paramCount = Math.min(
            args.length,
            layout.parameterExportNames.length,
          );
          for (let i = 0; i < paramCount; i++) {
            const paramName = createConstant(
              layout.parameterExportNames[i],
              PrimitiveTypes.string,
            );
            const externSig =
              "VRCUdonCommonInterfacesIUdonEventReceiver.__SetProgramVariable__SystemString_SystemObject__SystemVoid";
            this.instructions.push(
              new CallInstruction(undefined, externSig, [
                object,
                paramName,
                args[i],
              ]),
            );
          }
        }
        const sendExtern =
          "VRCUdonCommonInterfacesIUdonEventReceiver.__SendCustomEvent__SystemString__SystemVoid";
        this.instructions.push(
          new CallInstruction(undefined, sendExtern, [object, methodName]),
        );

        if (layout?.returnExportName) {
          const getExtern =
            "VRCUdonCommonInterfacesIUdonEventReceiver.__GetProgramVariable__SystemString__SystemObject";
          const returnName = createConstant(
            layout.returnExportName,
            PrimitiveTypes.string,
          );
          const returnTemp = this.newTemp(layout.returnType);
          this.instructions.push(
            new CallInstruction(returnTemp, getExtern, [object, returnName]),
          );
          return returnTemp;
        }

        return createConstant(0, PrimitiveTypes.void);
      }
      if (objectType.name === ExternTypes.dataList.name) {
        if (propAccess.property === "Add" && args.length === 1) {
          const token = this.wrapDataToken(args[0]);
          this.instructions.push(
            new MethodCallInstruction(undefined, object, "Add", [token]),
          );
          return createConstant(0, PrimitiveTypes.void);
        }
        if (propAccess.property === "Remove" && args.length === 1) {
          const token = this.wrapDataToken(args[0]);
          this.instructions.push(
            new MethodCallInstruction(result, object, "Remove", [token]),
          );
          return result;
        }
      }
      if (objectType.name === ExternTypes.dataDictionary.name) {
        if (propAccess.property === "SetValue" && args.length === 2) {
          const keyToken = this.wrapDataToken(args[0]);
          const valueToken = this.wrapDataToken(args[1]);
          this.instructions.push(
            new MethodCallInstruction(undefined, object, "SetValue", [
              keyToken,
              valueToken,
            ]),
          );
          return createConstant(0, PrimitiveTypes.void);
        }
        if (
          (propAccess.property === "ContainsKey" ||
            propAccess.property === "Remove") &&
          args.length === 1
        ) {
          const keyToken = this.wrapDataToken(args[0]);
          this.instructions.push(
            new MethodCallInstruction(result, object, propAccess.property, [
              keyToken,
            ]),
          );
          return result;
        }
      }
      if (propAccess.property === "RequestSerialization" && args.length === 0) {
        const externSig =
          "VRCUdonCommonInterfacesIUdonEventReceiver.__RequestSerialization__SystemVoid";
        this.instructions.push(new CallInstruction(undefined, externSig, []));
        return createConstant(0, PrimitiveTypes.void);
      }
      this.instructions.push(
        new MethodCallInstruction(result, object, propAccess.property, args),
      );
      return result;
    }

    if (callee.kind === ASTNodeKind.OptionalChainingExpression) {
      const opt = callee as OptionalChainingExpressionNode;
      const object = this.visitExpression(opt.object);
      const objTemp = this.newTemp(this.getOperandType(object));
      this.instructions.push(new CopyInstruction(objTemp, object));

      const isNull = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(
        new BinaryOpInstruction(
          isNull,
          objTemp,
          "==",
          createConstant(null, ObjectType),
        ),
      );
      const nullLabel = this.newLabel("opt_call_null");
      const endLabel = this.newLabel("opt_call_end");
      this.instructions.push(new ConditionalJumpInstruction(isNull, nullLabel));

      const callResult = this.newTemp(ObjectType);
      this.instructions.push(
        new MethodCallInstruction(callResult, objTemp, opt.property, args),
      );
      this.instructions.push(new UnconditionalJumpInstruction(endLabel));

      this.instructions.push(new LabelInstruction(nullLabel));
      this.instructions.push(
        new AssignmentInstruction(callResult, createConstant(null, ObjectType)),
      );
      this.instructions.push(new LabelInstruction(endLabel));
      return callResult;
    }

    throw new Error(`Unsupported call target kind: ${callee.kind}`);
  }

  private getUdonTypeConverterTargetType(
    methodName: string,
  ): TypeSymbol | null {
    switch (methodName) {
      case "toUdonByte":
        return this.typeMapper.mapTypeScriptType("UdonByte");
      case "toUdonInt":
        return this.typeMapper.mapTypeScriptType("UdonInt");
      case "toUdonFloat":
        return this.typeMapper.mapTypeScriptType("UdonFloat");
      case "toUdonDouble":
        return this.typeMapper.mapTypeScriptType("UdonDouble");
      case "toUdonLong":
      case "numberToUdonLong":
        return this.typeMapper.mapTypeScriptType("UdonLong");
      case "toUdonULong":
      case "numberToUdonULong":
        return this.typeMapper.mapTypeScriptType("UdonULong");
      default:
        return null;
    }
  }

  private visitObjectStaticCall(
    methodName: string,
    args: TACOperand[],
  ): TACOperand | null {
    if (args.length !== 1) return null;
    const target = args[0];
    const targetType = this.getOperandType(target);
    if (targetType.name !== ExternTypes.dataDictionary.name) {
      return null;
    }

    switch (methodName) {
      case "keys":
        return this.emitDataDictionaryKeys(target);
      case "values":
        return this.emitDataDictionaryValues(target);
      case "entries":
        return this.emitDataDictionaryEntries(target);
      default:
        return null;
    }
  }

  private emitDataDictionaryKeys(target: TACOperand): TACOperand {
    const result = this.newTemp(ExternTypes.dataList);
    this.instructions.push(
      new MethodCallInstruction(result, target, "GetKeys", []),
    );
    return result;
  }

  private visitNumberStaticCall(
    methodName: string,
    args: TACOperand[],
  ): TACOperand | null {
    switch (methodName) {
      case "isFinite": {
        if (args.length !== 1) return null;
        const value = args[0];
        const result = this.newTemp(PrimitiveTypes.boolean);
        this.instructions.push(
          new BinaryOpInstruction(result, value, "==", value),
        );
        return result;
      }
      case "parseInt": {
        if (args.length === 0) return null;
        const value = args[0];
        const result = this.newTemp(PrimitiveTypes.int32);
        const externSig = "SystemInt32.__Parse__SystemString__SystemInt32";
        this.instructions.push(new CallInstruction(result, externSig, [value]));
        return result;
      }
      default:
        return null;
    }
  }

  private visitMathStaticCall(
    methodName: string,
    args: TACOperand[],
  ): TACOperand | null {
    if (methodName === "random") {
      return createConstant(0, PrimitiveTypes.single);
    }

    if (methodName === "imul") {
      if (args.length !== 2) return null;
      const result = this.newTemp(PrimitiveTypes.int32);
      this.instructions.push(
        new BinaryOpInstruction(result, args[0], "*", args[1]),
      );
      return result;
    }

    const methodMap: Record<string, string> = {
      floor: "Floor",
      ceil: "Ceil",
      round: "Round",
      abs: "Abs",
      max: "Max",
      min: "Min",
      sqrt: "Sqrt",
      sin: "Sin",
      cos: "Cos",
      tan: "Tan",
      pow: "Pow",
    };
    const mapped = methodMap[methodName];
    if (!mapped) return null;

    if (methodName === "max" || methodName === "min") {
      if (args.length < 2) return null;
      let current = args[0];
      for (let i = 1; i < args.length; i += 1) {
        const stepResult = this.newTemp(PrimitiveTypes.single);
        const externSig = this.resolveStaticExtern("Mathf", mapped, "method");
        if (!externSig) return null;
        this.instructions.push(
          new CallInstruction(stepResult, externSig, [current, args[i]]),
        );
        current = stepResult;
      }
      return current;
    }

    if (args.length !== 1 && methodName !== "pow") return null;
    if (methodName === "pow" && args.length !== 2) return null;

    const result = this.newTemp(PrimitiveTypes.single);
    const externSig = this.resolveStaticExtern("Mathf", mapped, "method");
    if (!externSig) return null;
    this.instructions.push(new CallInstruction(result, externSig, args));
    return result;
  }

  private visitArrayStaticCall(
    methodName: string,
    args: TACOperand[],
  ): TACOperand | null {
    switch (methodName) {
      case "from":
        return args.length >= 1 ? args[0] : null;
      case "isArray":
        if (args.length !== 1) return null;
        return createConstant(true, PrimitiveTypes.boolean);
      default:
        return null;
    }
  }

  private emitDataDictionaryValues(target: TACOperand): TACOperand {
    const result = this.newTemp(ExternTypes.dataList);
    this.instructions.push(
      new MethodCallInstruction(result, target, "GetValues", []),
    );
    return result;
  }

  private emitDataDictionaryEntries(target: TACOperand): TACOperand {
    const result = this.newTemp(ExternTypes.dataList);
    const listCtorSig = "VRCSDKBaseDataList.__ctor____VRCSDKBaseDataList";
    this.instructions.push(new CallInstruction(result, listCtorSig, []));

    const keysList = this.newTemp(ExternTypes.dataList);
    this.instructions.push(
      new MethodCallInstruction(keysList, target, "GetKeys", []),
    );
    const valuesList = this.newTemp(ExternTypes.dataList);
    this.instructions.push(
      new MethodCallInstruction(valuesList, target, "GetValues", []),
    );

    const indexVar = this.newTemp(PrimitiveTypes.int32);
    const lengthVar = this.newTemp(PrimitiveTypes.int32);
    this.instructions.push(
      new AssignmentInstruction(
        indexVar,
        createConstant(0, PrimitiveTypes.int32),
      ),
    );
    this.instructions.push(
      new PropertyGetInstruction(lengthVar, keysList, "Count"),
    );

    const loopStart = this.newLabel("entries_start");
    const loopContinue = this.newLabel("entries_continue");
    const loopEnd = this.newLabel("entries_end");

    this.instructions.push(new LabelInstruction(loopStart));
    const condTemp = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
    );
    const notCond = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(new UnaryOpInstruction(notCond, "!", condTemp));
    this.instructions.push(new ConditionalJumpInstruction(notCond, loopEnd));

    const keyTemp = this.newTemp(ObjectType);
    this.instructions.push(
      new MethodCallInstruction(keyTemp, keysList, "get_Item", [indexVar]),
    );
    const valueTemp = this.newTemp(ObjectType);
    this.instructions.push(
      new MethodCallInstruction(valueTemp, valuesList, "get_Item", [indexVar]),
    );

    const pairList = this.newTemp(ExternTypes.dataList);
    this.instructions.push(new CallInstruction(pairList, listCtorSig, []));
    const keyToken = this.wrapDataToken(keyTemp);
    const valueToken = this.wrapDataToken(valueTemp);
    this.instructions.push(
      new MethodCallInstruction(undefined, pairList, "Add", [keyToken]),
    );
    this.instructions.push(
      new MethodCallInstruction(undefined, pairList, "Add", [valueToken]),
    );

    const pairToken = this.wrapDataToken(pairList);
    this.instructions.push(
      new MethodCallInstruction(undefined, result, "Add", [pairToken]),
    );

    this.instructions.push(new LabelInstruction(loopContinue));
    this.instructions.push(
      new BinaryOpInstruction(
        indexVar,
        indexVar,
        "+",
        createConstant(1, PrimitiveTypes.int32),
      ),
    );
    this.instructions.push(new UnconditionalJumpInstruction(loopStart));
    this.instructions.push(new LabelInstruction(loopEnd));

    return result;
  }

  /**
   * Visit assignment expression
   */
  private assignToTarget(target: ASTNode, value: TACOperand): TACOperand {
    if (target.kind === ASTNodeKind.ArrayAccessExpression) {
      const arrayAccess = target as ArrayAccessExpressionNode;
      const array = this.visitExpression(arrayAccess.array);
      const index = this.visitExpression(arrayAccess.index);
      const arrayType = this.getOperandType(array);
      if (arrayType instanceof CollectionTypeSymbol) {
        this.instructions.push(
          new MethodCallInstruction(undefined, array, "set_Item", [
            index,
            value,
          ]),
        );
        return value;
      }
      if (
        arrayType instanceof DataListTypeSymbol ||
        arrayType.name === ExternTypes.dataList.name
      ) {
        const token = this.wrapDataToken(value);
        this.instructions.push(
          new MethodCallInstruction(undefined, array, "set_Item", [
            index,
            token,
          ]),
        );
        return value;
      }
      this.instructions.push(
        new ArrayAssignmentInstruction(array, index, value),
      );
      return value;
    }

    if (target.kind === ASTNodeKind.PropertyAccessExpression) {
      const propAccess = target as PropertyAccessExpressionNode;
      if (
        propAccess.object.kind === ASTNodeKind.ThisExpression &&
        this.currentInlineContext
      ) {
        const mapped = this.mapInlineProperty(
          this.currentInlineContext.className,
          this.currentInlineContext.instancePrefix,
          propAccess.property,
        );
        if (mapped) {
          this.instructions.push(new CopyInstruction(mapped, value));
          return value;
        }
      }
      if (propAccess.object.kind === ASTNodeKind.Identifier) {
        const instanceInfo = this.inlineInstanceMap.get(
          (propAccess.object as IdentifierNode).name,
        );
        if (instanceInfo) {
          const mapped = this.mapInlineProperty(
            instanceInfo.className,
            instanceInfo.prefix,
            propAccess.property,
          );
          if (mapped) {
            this.instructions.push(new CopyInstruction(mapped, value));
            return value;
          }
        }
      }
      if (this.isUdonBehaviourPropertyAccess(propAccess)) {
        const object = this.visitExpression(propAccess.object);
        const externSig =
          "VRCUdonCommonInterfacesIUdonEventReceiver.__SetProgramVariable__SystemString_SystemObject__SystemVoid";
        const propName = createConstant(
          propAccess.property,
          PrimitiveTypes.string,
        );
        this.instructions.push(
          new CallInstruction(undefined, externSig, [object, propName, value]),
        );
        return value;
      }
      const object = this.visitExpression(propAccess.object);
      this.instructions.push(
        new PropertySetInstruction(object, propAccess.property, value),
      );
      const callback = this.resolveFieldChangeCallback(
        propAccess.object,
        propAccess.property,
      );
      if (callback) {
        this.instructions.push(
          new MethodCallInstruction(undefined, object, callback, []),
        );
      }
      return value;
    }

    const targetOperand = this.visitExpression(target);
    this.instructions.push(new CopyInstruction(targetOperand, value));
    if (targetOperand.kind === TACOperandKind.Variable) {
      this.maybeTrackInlineInstanceAssignment(
        targetOperand as VariableOperand,
        value,
      );
    }
    return targetOperand;
  }

  private visitAssignmentExpression(
    node: AssignmentExpressionNode,
  ): TACOperand {
    const value = this.visitExpression(node.value);
    return this.assignToTarget(node.target, value);
  }

  private visitUpdateExpression(node: UpdateExpressionNode): TACOperand {
    const oldValue = this.visitExpression(node.operand);
    const delta = createConstant(1, PrimitiveTypes.int32);
    const resultType = this.getOperandType(oldValue);
    const newValue = this.newTemp(resultType);
    this.instructions.push(
      new BinaryOpInstruction(newValue, oldValue, node.operator, delta),
    );
    const assignedValue = this.assignToTarget(node.operand, newValue);
    return node.isPostfix ? oldValue : assignedValue;
  }

  private visitTryCatchStatement(node: TryCatchStatementNode): void {
    const tryId = this.tryCounter++;
    const errorFlagName = `__error_flag_${tryId}`;
    const errorValueName = `__error_value_${tryId}`;

    if (!this.symbolTable.hasInCurrentScope(errorFlagName)) {
      this.symbolTable.addSymbol(
        errorFlagName,
        PrimitiveTypes.boolean,
        false,
        false,
      );
    }
    if (!this.symbolTable.hasInCurrentScope(errorValueName)) {
      this.symbolTable.addSymbol(errorValueName, ObjectType, false, false);
    }

    const errorFlagVar = createVariable(errorFlagName, PrimitiveTypes.boolean);
    const errorValueVar = createVariable(errorValueName, ObjectType);
    const catchLabel = node.catchBody
      ? this.newLabel(`catch_${tryId}`)
      : undefined;
    const finallyLabel = node.finallyBody
      ? this.newLabel(`finally_${tryId}`)
      : undefined;
    const endLabel = this.newLabel(`try_end_${tryId}`);
    const errorTarget = catchLabel ?? finallyLabel ?? endLabel;

    this.instructions.push(
      new AssignmentInstruction(
        errorFlagVar,
        createConstant(false, PrimitiveTypes.boolean),
      ),
    );
    this.instructions.push(
      new AssignmentInstruction(
        errorValueVar,
        createConstant(null, ObjectType),
      ),
    );

    const previousInstructions = this.instructions;
    const tryInstructions: TACInstruction[] = [];
    this.instructions = tryInstructions;

    this.tryContextStack.push({
      errorFlag: errorFlagVar,
      errorValue: errorValueVar,
      errorTarget,
    });
    this.visitBlockStatement(node.tryBody);
    this.tryContextStack.pop();

    this.instructions = previousInstructions;
    this.emitTryInstructionsWithChecks(
      tryInstructions,
      errorFlagVar,
      errorValueVar,
      errorTarget,
    );

    if (catchLabel) {
      this.instructions.push(
        new UnconditionalJumpInstruction(finallyLabel ?? endLabel),
      );
      this.instructions.push(new LabelInstruction(catchLabel));
      if (node.catchBody) {
        this.symbolTable.enterScope();
        if (node.catchVariable) {
          if (!this.symbolTable.hasInCurrentScope(node.catchVariable)) {
            this.symbolTable.addSymbol(
              node.catchVariable,
              ObjectType,
              false,
              false,
            );
          }
          const catchVar = createVariable(node.catchVariable, ObjectType, {
            isLocal: true,
          });
          this.instructions.push(new CopyInstruction(catchVar, errorValueVar));
        }
        this.scanDeclarations(node.catchBody.statements);
        for (const stmt of node.catchBody.statements) {
          this.visitStatement(stmt);
        }
        this.symbolTable.exitScope();
      }
    }

    if (finallyLabel && node.finallyBody) {
      this.instructions.push(new UnconditionalJumpInstruction(finallyLabel));
      this.instructions.push(new LabelInstruction(finallyLabel));
      this.visitBlockStatement(node.finallyBody);
    }

    this.instructions.push(new LabelInstruction(endLabel));
  }

  private visitThrowStatement(node: ThrowStatementNode): void {
    const context = this.tryContextStack[this.tryContextStack.length - 1];
    if (!context) {
      const value = this.visitExpression(node.expression);
      const externSig = "UnityEngineDebug.__LogError__SystemObject__SystemVoid";
      this.instructions.push(
        new CallInstruction(undefined, externSig, [value]),
      );
      const inlineContext =
        this.inlineReturnStack[this.inlineReturnStack.length - 1];
      if (inlineContext) {
        this.instructions.push(
          new UnconditionalJumpInstruction(inlineContext.returnLabel),
        );
      } else {
        this.instructions.push(
          new ReturnInstruction(undefined, this.currentReturnVar),
        );
      }
      return;
    }
    const value = this.visitExpression(node.expression);
    this.instructions.push(
      new AssignmentInstruction(
        context.errorFlag,
        createConstant(true, PrimitiveTypes.boolean),
      ),
    );
    this.instructions.push(new CopyInstruction(context.errorValue, value));
    this.instructions.push(
      new UnconditionalJumpInstruction(context.errorTarget),
    );
  }

  private visitEnumDeclaration(_node: EnumDeclarationNode): void {
    // enums are compile-time only
  }

  private visitAsExpression(node: AsExpressionNode): TACOperand {
    const operand = this.visitExpression(node.expression);
    const targetTypeText = node.targetType.trim();
    if (targetTypeText === "const") {
      return operand;
    }
    const targetTypeSymbol = this.typeMapper.mapTypeScriptType(targetTypeText);
    const result = this.newTemp(targetTypeSymbol);
    this.instructions.push(new CopyInstruction(result, operand));
    return result;
  }

  private visitNameofExpression(node: NameofExpressionNode): TACOperand {
    return createConstant(node.name, PrimitiveTypes.string);
  }

  private visitTypeofExpression(node: TypeofExpressionNode): TACOperand {
    const typeNameConst = createConstant(node.typeName, PrimitiveTypes.string);
    const result = this.newTemp(ExternTypes.systemType);
    const externSig = "SystemType.__GetType__SystemString__SystemType";
    this.instructions.push(
      new CallInstruction(result, externSig, [typeNameConst]),
    );
    return result;
  }

  private visitOptionalChainingExpression(
    node: OptionalChainingExpressionNode,
  ): TACOperand {
    const obj = this.visitExpression(node.object);
    const objTemp = this.newTemp(this.getOperandType(obj));
    this.instructions.push(new CopyInstruction(objTemp, obj));

    const isNull = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new BinaryOpInstruction(
        isNull,
        objTemp,
        "==",
        createConstant(null, ObjectType),
      ),
    );
    const nullLabel = this.newLabel("opt_null");
    const endLabel = this.newLabel("opt_end");
    this.instructions.push(new ConditionalJumpInstruction(isNull, nullLabel));

    const result = this.newTemp(ObjectType);
    this.instructions.push(
      new PropertyGetInstruction(result, objTemp, node.property),
    );
    this.instructions.push(new UnconditionalJumpInstruction(endLabel));

    this.instructions.push(new LabelInstruction(nullLabel));
    this.instructions.push(
      new AssignmentInstruction(result, createConstant(null, ObjectType)),
    );
    this.instructions.push(new LabelInstruction(endLabel));

    return result;
  }

  private visitInlineConstructor(
    className: string,
    args: TACOperand[],
  ): TACOperand {
    if (
      this.inSerializeFieldInitializer &&
      this.udonBehaviourClasses.has(className)
    ) {
      const fallback = this.newTemp(ObjectType);
      this.instructions.push(new CallInstruction(fallback, className, args));
      return fallback;
    }
    if (this.entryPointClasses.has(className)) {
      const fallback = this.newTemp(ObjectType);
      this.instructions.push(new CallInstruction(fallback, className, args));
      return fallback;
    }

    const classNode = this.classMap.get(className);
    if (!classNode) {
      const fallback = this.newTemp(ObjectType);
      this.instructions.push(new CallInstruction(fallback, className, args));
      return fallback;
    }

    const instancePrefix = `__inst_${className}_${this.instanceCounter++}`;
    const instanceHandle = createVariable(
      `${instancePrefix}__handle`,
      ObjectType,
    );
    this.inlineInstanceMap.set(instanceHandle.name, {
      prefix: instancePrefix,
      className,
    });

    for (const prop of classNode.properties) {
      if (!prop.initializer) continue;
      const previousSerializeFieldState = this.inSerializeFieldInitializer;
      this.inSerializeFieldInitializer = !!prop.isSerializeField;
      const propVar = createVariable(
        `${instancePrefix}_${prop.name}`,
        prop.type,
      );
      const value = this.visitExpression(prop.initializer);
      this.inSerializeFieldInitializer = previousSerializeFieldState;
      this.instructions.push(new AssignmentInstruction(propVar, value));
    }

    if (classNode.constructor) {
      this.symbolTable.enterScope();
      for (let i = 0; i < classNode.constructor.parameters.length; i++) {
        const param = classNode.constructor.parameters[i];
        const paramType = this.typeMapper.mapTypeScriptType(param.type);
        if (!this.symbolTable.hasInCurrentScope(param.name)) {
          this.symbolTable.addSymbol(param.name, paramType, true, false);
        }
        if (args[i]) {
          this.instructions.push(
            new CopyInstruction(
              createVariable(param.name, paramType, { isParameter: true }),
              args[i],
            ),
          );
        }
      }
      const previousContext = this.currentInlineContext;
      this.currentInlineContext = { className, instancePrefix };
      this.visitStatement(classNode.constructor.body);
      this.currentInlineContext = previousContext;
      this.symbolTable.exitScope();
    }

    return instanceHandle;
  }

  private visitInlineStaticMethodCall(
    className: string,
    methodName: string,
    args: TACOperand[],
  ): TACOperand | null {
    const inlineKey = `${className}.${methodName}`;
    if (this.inlineStaticMethodStack.has(inlineKey)) {
      return null;
    }
    const classNode = this.classMap.get(className);
    if (!classNode) return null;
    const method = classNode.methods.find(
      (candidate) => candidate.name === methodName && candidate.isStatic,
    );
    if (!method) return null;

    const returnType = method.returnType;
    const result = this.newTemp(returnType);
    const returnLabel = this.newLabel("inline_return");

    this.symbolTable.enterScope();
    for (let i = 0; i < method.parameters.length; i++) {
      const param = method.parameters[i];
      if (!this.symbolTable.hasInCurrentScope(param.name)) {
        this.symbolTable.addSymbol(param.name, param.type, true, false);
      }
      if (args[i]) {
        this.instructions.push(
          new CopyInstruction(
            createVariable(param.name, param.type, { isParameter: true }),
            args[i],
          ),
        );
      }
    }

    this.inlineStaticMethodStack.add(inlineKey);
    this.inlineReturnStack.push({ returnVar: result, returnLabel });
    try {
      this.visitBlockStatement(method.body);
    } finally {
      this.inlineReturnStack.pop();
      this.inlineStaticMethodStack.delete(inlineKey);
    }
    this.symbolTable.exitScope();

    this.instructions.push(new LabelInstruction(returnLabel));
    return result;
  }

  private maybeTrackInlineInstanceAssignment(
    target: VariableOperand,
    value: TACOperand,
  ): void {
    if (value.kind !== TACOperandKind.Variable) return;
    const mapped = this.inlineInstanceMap.get((value as VariableOperand).name);
    if (mapped) {
      this.inlineInstanceMap.set(target.name, mapped);
    }
  }

  private mapInlineProperty(
    className: string,
    instancePrefix: string,
    property: string,
  ): VariableOperand | undefined {
    const classNode = this.classMap.get(className);
    const prop = classNode?.properties.find((p) => p.name === property);
    if (!prop) return undefined;
    return createVariable(`${instancePrefix}_${property}`, prop.type);
  }

  private resolveFieldChangeCallback(
    object: ASTNode,
    property: string,
  ): string | null {
    let className: string | undefined;
    if (object.kind === ASTNodeKind.ThisExpression) {
      className = this.currentClassName;
    } else if (object.kind === ASTNodeKind.Identifier) {
      const instanceInfo = this.inlineInstanceMap.get(
        (object as IdentifierNode).name,
      );
      if (instanceInfo) {
        className = instanceInfo.className;
      }
    }

    if (!className) return null;
    const classNode = this.classMap.get(className);
    const prop = classNode?.properties.find((p) => p.name === property);
    return prop?.fieldChangeCallback ?? null;
  }

  private emitOnDeserializationForFieldChangeCallbacks(
    classNode: ClassDeclarationNode,
  ): void {
    const callbacks = classNode.properties.filter(
      (prop) => !!prop.fieldChangeCallback,
    );
    if (callbacks.length === 0) return;

    const label = createLabel("_onDeserialization");
    this.instructions.push(new LabelInstruction(label));
    this.currentReturnVar = "__returnValue_return";
    this.symbolTable.enterScope();

    const thisVar = createVariable("this", ObjectType);

    for (const prop of callbacks) {
      const prevVar = createVariable(`__prev_${prop.name}`, prop.type);
      if (!this.symbolTable.hasInCurrentScope(prevVar.name)) {
        this.symbolTable.addSymbol(prevVar.name, prop.type, false, false);
      }

      const currentVal = this.newTemp(prop.type);
      this.instructions.push(
        new PropertyGetInstruction(currentVal, thisVar, prop.name),
      );

      const changed = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(
        new BinaryOpInstruction(changed, currentVal, "!=", prevVar),
      );
      const skipLabel = this.newLabel("fcb_skip");
      const notChanged = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(new UnaryOpInstruction(notChanged, "!", changed));
      this.instructions.push(
        new ConditionalJumpInstruction(notChanged, skipLabel),
      );
      this.instructions.push(new CopyInstruction(prevVar, currentVal));
      if (prop.fieldChangeCallback) {
        this.instructions.push(
          new MethodCallInstruction(
            undefined,
            thisVar,
            prop.fieldChangeCallback,
            [],
          ),
        );
      }
      this.instructions.push(new LabelInstruction(skipLabel));
    }

    this.instructions.push(
      new ReturnInstruction(undefined, this.currentReturnVar),
    );
    this.symbolTable.exitScope();
    this.currentReturnVar = undefined;
  }

  private resolveStaticExtern(
    typeName: string,
    memberName: string,
    accessType: "method" | "getter",
  ): string | null {
    const direct = resolveExternSignature(typeName, memberName, accessType);
    if (direct) return direct;
    if (accessType === "getter") {
      return resolveExternSignature(typeName, memberName, "method");
    }
    return null;
  }

  private emitTryInstructionsWithChecks(
    instructions: TACInstruction[],
    errorFlag: VariableOperand,
    errorValue: VariableOperand,
    errorTarget: TACOperand,
  ): void {
    for (const inst of instructions) {
      this.instructions.push(inst);

      const checkOperand = this.getCheckOperand(inst);
      if (!checkOperand) continue;
      const checkType = this.getOperandType(checkOperand);
      if (!this.isNullableType(checkType)) continue;

      const isNullTemp = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(
        new BinaryOpInstruction(
          isNullTemp,
          checkOperand,
          "==",
          createConstant(null, ObjectType),
        ),
      );
      const setLabel = this.newLabel("try_error_set");
      const continueLabel = this.newLabel("try_continue");
      this.instructions.push(
        new ConditionalJumpInstruction(isNullTemp, setLabel),
      );
      this.instructions.push(new UnconditionalJumpInstruction(continueLabel));
      this.instructions.push(new LabelInstruction(setLabel));
      this.instructions.push(
        new AssignmentInstruction(
          errorFlag,
          createConstant(true, PrimitiveTypes.boolean),
        ),
      );
      this.instructions.push(new CopyInstruction(errorValue, checkOperand));
      this.instructions.push(new UnconditionalJumpInstruction(errorTarget));
      this.instructions.push(new LabelInstruction(continueLabel));
    }
  }

  private getCheckOperand(inst: TACInstruction): TACOperand | null {
    switch (inst.kind) {
      case TACInstructionKind.Call:
        return (inst as CallInstruction).dest ?? null;
      case TACInstructionKind.MethodCall:
        return (inst as MethodCallInstruction).dest ?? null;
      case TACInstructionKind.PropertyGet:
        return (inst as PropertyGetInstruction).dest ?? null;
      default:
        return null;
    }
  }

  private isNullableType(type: TypeSymbol): boolean {
    switch (type.udonType) {
      case UdonType.Boolean:
      case UdonType.Byte:
      case UdonType.SByte:
      case UdonType.Int16:
      case UdonType.UInt16:
      case UdonType.Int32:
      case UdonType.UInt32:
      case UdonType.Int64:
      case UdonType.UInt64:
      case UdonType.Single:
      case UdonType.Double:
      case UdonType.Void:
        return false;
      default:
        return true;
    }
  }

  private collectRecursiveLocals(method: {
    parameters: Array<{ name: string; type: TypeSymbol }>;
    body: BlockStatementNode;
  }): Array<{ name: string; type: TypeSymbol }> {
    const locals = new Map<string, TypeSymbol>();
    for (const param of method.parameters) {
      locals.set(param.name, param.type);
    }

    const visitNode = (node: ASTNode): void => {
      switch (node.kind) {
        case ASTNodeKind.VariableDeclaration: {
          const varNode = node as VariableDeclarationNode;
          locals.set(varNode.name, varNode.type);
          if (varNode.initializer) visitNode(varNode.initializer);
          break;
        }
        case ASTNodeKind.BlockStatement: {
          const block = node as BlockStatementNode;
          for (const stmt of block.statements) visitNode(stmt);
          break;
        }
        case ASTNodeKind.IfStatement: {
          const ifNode = node as IfStatementNode;
          visitNode(ifNode.condition);
          visitNode(ifNode.thenBranch);
          if (ifNode.elseBranch) visitNode(ifNode.elseBranch);
          break;
        }
        case ASTNodeKind.WhileStatement: {
          const whileNode = node as WhileStatementNode;
          visitNode(whileNode.condition);
          visitNode(whileNode.body);
          break;
        }
        case ASTNodeKind.ForStatement: {
          const forNode = node as ForStatementNode;
          if (forNode.initializer) visitNode(forNode.initializer);
          if (forNode.condition) visitNode(forNode.condition);
          if (forNode.incrementor) visitNode(forNode.incrementor);
          visitNode(forNode.body);
          break;
        }
        case ASTNodeKind.ForOfStatement: {
          const forOfNode = node as ForOfStatementNode;
          visitNode(forOfNode.iterable);
          visitNode(forOfNode.body);
          break;
        }
        case ASTNodeKind.DoWhileStatement: {
          const doNode = node as DoWhileStatementNode;
          visitNode(doNode.body);
          visitNode(doNode.condition);
          break;
        }
        case ASTNodeKind.SwitchStatement: {
          const switchNode = node as SwitchStatementNode;
          visitNode(switchNode.expression);
          for (const clause of switchNode.cases) {
            if (clause.expression) visitNode(clause.expression);
            for (const stmt of clause.statements) visitNode(stmt);
          }
          break;
        }
        case ASTNodeKind.CallExpression: {
          const callNode = node as CallExpressionNode;
          visitNode(callNode.callee);
          for (const arg of callNode.arguments) visitNode(arg);
          break;
        }
        case ASTNodeKind.AssignmentExpression: {
          const assignNode = node as AssignmentExpressionNode;
          visitNode(assignNode.target);
          visitNode(assignNode.value);
          break;
        }
        case ASTNodeKind.BinaryExpression: {
          const binNode = node as BinaryExpressionNode;
          visitNode(binNode.left);
          visitNode(binNode.right);
          break;
        }
        case ASTNodeKind.UnaryExpression: {
          const unNode = node as UnaryExpressionNode;
          visitNode(unNode.operand);
          break;
        }
        case ASTNodeKind.PropertyAccessExpression: {
          const propNode = node as PropertyAccessExpressionNode;
          visitNode(propNode.object);
          break;
        }
        case ASTNodeKind.ReturnStatement: {
          const retNode = node as ReturnStatementNode;
          if (retNode.value) visitNode(retNode.value);
          break;
        }
        case ASTNodeKind.AsExpression: {
          const asNode = node as AsExpressionNode;
          visitNode(asNode.expression);
          break;
        }
        default:
          break;
      }
    };

    visitNode(method.body);
    return Array.from(locals.entries()).map(([name, type]) => ({ name, type }));
  }

  private emitRecursivePrologue(): void {
    const context = this.currentRecursiveContext;
    if (!context) return;

    const depthVar = createVariable(context.depthVar, PrimitiveTypes.int32);
    const depthTemp = this.newTemp(PrimitiveTypes.int32);
    this.instructions.push(
      new BinaryOpInstruction(
        depthTemp,
        depthVar,
        "+",
        createConstant(1, PrimitiveTypes.int32),
      ),
    );
    this.instructions.push(new CopyInstruction(depthVar, depthTemp));

    for (let index = 0; index < context.locals.length; index++) {
      const local = context.locals[index];
      const stackVarInfo = context.stackVars[index];
      const stackVar = createVariable(stackVarInfo.name, stackVarInfo.type);
      const localVar = createVariable(local.name, local.type, {
        isLocal: true,
      });
      this.instructions.push(
        new ArrayAssignmentInstruction(stackVar, depthVar, localVar),
      );
    }
  }

  private emitRecursiveEpilogue(): void {
    const context = this.currentRecursiveContext;
    if (!context) return;

    const depthVar = createVariable(context.depthVar, PrimitiveTypes.int32);

    for (let index = 0; index < context.locals.length; index++) {
      const local = context.locals[index];
      const stackVarInfo = context.stackVars[index];
      const stackVar = createVariable(stackVarInfo.name, stackVarInfo.type);
      const temp = this.newTemp(local.type);
      this.instructions.push(
        new ArrayAccessInstruction(temp, stackVar, depthVar),
      );
      this.instructions.push(
        new CopyInstruction(
          createVariable(local.name, local.type, { isLocal: true }),
          temp,
        ),
      );
    }

    const depthTemp = this.newTemp(PrimitiveTypes.int32);
    this.instructions.push(
      new BinaryOpInstruction(
        depthTemp,
        depthVar,
        "-",
        createConstant(1, PrimitiveTypes.int32),
      ),
    );
    this.instructions.push(new CopyInstruction(depthVar, depthTemp));
  }

  /**
   * Get the type of an operand
   */
  private getOperandType(operand: TACOperand): TypeSymbol {
    switch (operand.kind) {
      case TACOperandKind.Variable:
      case TACOperandKind.Constant:
      case TACOperandKind.Temporary:
        return (operand as VariableOperand | ConstantOperand | TemporaryOperand)
          .type;
      default:
        return ObjectType;
    }
  }

  private mergeTemplateParts(parts: TemplatePart[]): TemplatePart[] {
    const merged: TemplatePart[] = [];
    let textBuffer = "";
    for (const part of parts) {
      if (part.kind === "text") {
        textBuffer += part.value;
        continue;
      }
      if (textBuffer.length > 0) {
        merged.push({ kind: "text", value: textBuffer });
        textBuffer = "";
      }
      merged.push(part);
    }
    if (textBuffer.length > 0) {
      merged.push({ kind: "text", value: textBuffer });
    }
    return merged;
  }

  private tryFoldTemplateExpression(
    parts: TemplatePart[],
  ): ConstantOperand | null {
    let output = "";
    for (const part of parts) {
      if (part.kind === "text") {
        output += part.value;
        continue;
      }
      if (part.expression.kind !== ASTNodeKind.Literal) {
        return null;
      }
      const literal = part.expression as LiteralNode;
      const folded = this.templateLiteralValueToString(literal.value);
      if (folded === null) return null;
      output += folded;
    }
    return createConstant(output, PrimitiveTypes.string);
  }

  private templateLiteralValueToString(
    value: LiteralNode["value"],
  ): string | null {
    if (value === null) return "null";
    const valueType = typeof value;
    if (
      valueType === "string" ||
      valueType === "number" ||
      valueType === "boolean" ||
      valueType === "bigint"
    ) {
      return String(value);
    }
    return null;
  }

  private tryResolveUnitySelfReference(
    node: PropertyAccessExpressionNode,
  ): VariableOperand | null {
    if (node.object.kind !== ASTNodeKind.ThisExpression) return null;
    if (node.property === "gameObject") {
      return createVariable("__gameObject", ExternTypes.gameObject);
    }
    if (node.property === "transform") {
      return createVariable("__transform", ExternTypes.transform);
    }
    return null;
  }

  private coerceSwitchOperand(
    operand: TACOperand,
    targetType: TypeSymbol,
  ): TACOperand {
    const sourceType = this.getOperandType(operand);
    if (sourceType.udonType === targetType.udonType) {
      return operand;
    }

    if (operand.kind === TACOperandKind.Constant) {
      const constant = operand as ConstantOperand;
      const coerced = this.coerceConstantToType(constant, targetType);
      if (coerced) return coerced;
    }

    if (
      this.isSwitchComparableType(sourceType) &&
      this.isSwitchComparableType(targetType)
    ) {
      const casted = this.newTemp(targetType);
      this.instructions.push(new CastInstruction(casted, operand));
      return casted;
    }

    return operand;
  }

  private coerceConstantToType(
    operand: ConstantOperand,
    targetType: TypeSymbol,
  ): ConstantOperand | null {
    if (operand.value === null) return null;
    const raw = operand.value;
    if (typeof raw === "object") return null;
    switch (targetType.udonType) {
      case UdonType.String:
        return createConstant(String(raw), PrimitiveTypes.string);
      case UdonType.Boolean:
        return createConstant(Boolean(raw), PrimitiveTypes.boolean);
      case UdonType.Int32: {
        const num = typeof raw === "number" ? raw : Number(raw);
        if (Number.isNaN(num)) return null;
        return createConstant(Math.trunc(num), PrimitiveTypes.int32);
      }
      case UdonType.Single: {
        const num = typeof raw === "number" ? raw : Number(raw);
        if (Number.isNaN(num)) return null;
        return createConstant(num, PrimitiveTypes.single);
      }
      default:
        return null;
    }
  }

  private isSwitchComparableType(type: TypeSymbol): boolean {
    switch (type.udonType) {
      case UdonType.Int32:
      case UdonType.UInt32:
      case UdonType.Int16:
      case UdonType.UInt16:
      case UdonType.Int64:
      case UdonType.UInt64:
      case UdonType.Byte:
      case UdonType.SByte:
      case UdonType.Single:
      case UdonType.Double:
      case UdonType.String:
      case UdonType.Boolean:
        return true;
      default:
        return false;
    }
  }

  private getArrayElementType(operand: TACOperand): TypeSymbol | null {
    if (
      operand.kind === TACOperandKind.Variable ||
      operand.kind === TACOperandKind.Temporary ||
      operand.kind === TACOperandKind.Constant
    ) {
      const type = (
        operand as VariableOperand | TemporaryOperand | ConstantOperand
      ).type;
      if (type instanceof ArrayTypeSymbol) {
        return type.elementType;
      }
    }
    return null;
  }

  private wrapDataToken(value: TACOperand): TACOperand {
    const valueType = this.getOperandType(value);
    if (valueType.name === ExternTypes.dataToken.name) {
      return value;
    }
    const token = this.newTemp(ExternTypes.dataToken);
    const csharpType = mapTypeScriptToCSharp(valueType.name);
    const externSig = generateExternSignature(
      "VRC.SDK3.Data.DataToken",
      "ctor",
      [csharpType],
      "VRC.SDK3.Data.DataToken",
    );
    this.instructions.push(new CallInstruction(token, externSig, [value]));
    return token;
  }

  /**
   * Check if node is a statement node
   */
  private isStatementNode(node: ASTNode): boolean {
    return (
      node.kind === ASTNodeKind.VariableDeclaration ||
      node.kind === ASTNodeKind.IfStatement ||
      node.kind === ASTNodeKind.WhileStatement ||
      node.kind === ASTNodeKind.ForStatement ||
      node.kind === ASTNodeKind.ForOfStatement ||
      node.kind === ASTNodeKind.BlockStatement ||
      node.kind === ASTNodeKind.ClassDeclaration
    );
  }
}

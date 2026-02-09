import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ArrayTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  ObjectType,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";
import {
  type ASTNode,
  ASTNodeKind,
  type BlockStatementNode,
  type BreakStatementNode,
  type ClassDeclarationNode,
  type ContinueStatementNode,
  type DoWhileStatementNode,
  type EnumDeclarationNode,
  type ForOfStatementNode,
  type ForStatementNode,
  type IfStatementNode,
  type ReturnStatementNode,
  type SwitchStatementNode,
  type ThrowStatementNode,
  type TryCatchStatementNode,
  UdonType,
  type VariableDeclarationNode,
  type WhileStatementNode,
} from "../../../frontend/types.js";
import { getVrcEventDefinition } from "../../../vrc/event_registry.js";
import {
  ArrayAccessInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  ReturnInstruction,
  type TACInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  createConstant,
  createLabel,
  createVariable,
  type TACOperand,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";
import {
  isMapCollectionType,
  isSetCollectionType,
} from "../helpers/collections.js";
import { resolveTypeFromNode } from "./expression.js";

export function visitStatement(this: ASTToTACConverter, node: ASTNode): void {
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

export function visitVariableDeclaration(
  this: ASTToTACConverter,
  node: VariableDeclarationNode,
): void {
  // Top-level literal constants are inlined at use-site; just register in symbol table
  if (
    node.isConst &&
    this.symbolTable.getCurrentScope() === 0 &&
    node.initializer?.kind === ASTNodeKind.Literal
  ) {
    if (!this.symbolTable.hasInCurrentScope(node.name)) {
      this.symbolTable.addSymbol(
        node.name,
        node.type,
        false,
        true,
        node.initializer,
      );
    }
    return;
  }

  const isObjectTypeSymbol = (type: TypeSymbol): boolean =>
    type.name === ObjectType.name && type.udonType === ObjectType.udonType;
  let destType: TypeSymbol = node.type;
  let src: TACOperand | null = null;

  if (node.initializer) {
    src = this.visitExpression(node.initializer);
    if (
      isObjectTypeSymbol(destType) ||
      (destType.name === PrimitiveTypes.single.name &&
        destType.udonType === PrimitiveTypes.single.udonType)
    ) {
      const inferredType = this.getOperandType(src);
      if (!isObjectTypeSymbol(inferredType)) {
        destType = inferredType;
      } else {
        const resolvedType = resolveTypeFromNode(this, node.initializer);
        if (resolvedType && !isObjectTypeSymbol(resolvedType)) {
          destType = resolvedType;
        }
      }
    }
  }

  const isLocal = this.symbolTable.getCurrentScope() > 0;
  const dest = createVariable(node.name, destType, { isLocal });

  if (!this.symbolTable.hasInCurrentScope(node.name)) {
    this.symbolTable.addSymbol(
      node.name,
      destType,
      false,
      node.isConst,
      node.initializer,
    );
  } else {
    this.symbolTable.updateTypeInCurrentScope(node.name, destType);
    if (node.initializer) {
      this.symbolTable.updateInitialValueInCurrentScope(
        node.name,
        node.initializer,
      );
    }
  }

  if (src) {
    this.instructions.push(new AssignmentInstruction(dest, src));
    this.maybeTrackInlineInstanceAssignment(dest, src);
  }
}

export function visitIfStatement(
  this: ASTToTACConverter,
  node: IfStatementNode,
): void {
  const condition = this.visitExpression(node.condition);
  const elseLabel = this.newLabel("else");
  const endLabel = this.newLabel("endif");

  this.instructions.push(new ConditionalJumpInstruction(condition, elseLabel));

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

export function visitWhileStatement(
  this: ASTToTACConverter,
  node: WhileStatementNode,
): void {
  const startLabel = this.newLabel("while_start");
  const endLabel = this.newLabel("while_end");

  // Start label
  this.instructions.push(new LabelInstruction(startLabel));

  // Condition
  const condition = this.visitExpression(node.condition);
  this.instructions.push(new ConditionalJumpInstruction(condition, endLabel));

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

export function visitForStatement(
  this: ASTToTACConverter,
  node: ForStatementNode,
): void {
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
    this.instructions.push(new ConditionalJumpInstruction(condition, endLabel));
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

const emitMapEntriesList = (
  converter: ASTToTACConverter,
  mapOperand: TACOperand,
): TACOperand => {
  const entriesType = new DataListTypeSymbol(ExternTypes.dataToken);
  const entriesResult = converter.newTemp(entriesType);
  const listCtorSig = converter.requireExternSignature(
    "DataList",
    "ctor",
    "method",
    [],
    "DataList",
  );
  converter.instructions.push(
    new CallInstruction(entriesResult, listCtorSig, []),
  );

  const keysList = converter.newTemp(
    new DataListTypeSymbol(ExternTypes.dataToken),
  );
  converter.instructions.push(
    new MethodCallInstruction(keysList, mapOperand, "GetKeys", []),
  );

  const indexVar = converter.newTemp(PrimitiveTypes.int32);
  const lengthVar = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new AssignmentInstruction(
      indexVar,
      createConstant(0, PrimitiveTypes.int32),
    ),
  );
  converter.instructions.push(
    new PropertyGetInstruction(lengthVar, keysList, "Count"),
  );

  const loopStart = converter.newLabel("map_forof_entries_start");
  const loopContinue = converter.newLabel("map_forof_entries_continue");
  const loopEnd = converter.newLabel("map_forof_entries_end");

  converter.instructions.push(new LabelInstruction(loopStart));
  const condTemp = converter.newTemp(PrimitiveTypes.boolean);
  converter.instructions.push(
    new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
  );
  converter.instructions.push(
    new ConditionalJumpInstruction(condTemp, loopEnd),
  );

  const keyToken = converter.newTemp(ExternTypes.dataToken);
  converter.instructions.push(
    new MethodCallInstruction(keyToken, keysList, "get_Item", [indexVar]),
  );
  const valueToken = converter.newTemp(ExternTypes.dataToken);
  converter.instructions.push(
    new MethodCallInstruction(valueToken, mapOperand, "GetValue", [keyToken]),
  );

  const pairList = converter.newTemp(
    new DataListTypeSymbol(ExternTypes.dataToken),
  );
  converter.instructions.push(new CallInstruction(pairList, listCtorSig, []));
  converter.instructions.push(
    new MethodCallInstruction(undefined, pairList, "Add", [keyToken]),
  );
  converter.instructions.push(
    new MethodCallInstruction(undefined, pairList, "Add", [valueToken]),
  );
  const pairToken = converter.wrapDataToken(pairList);
  converter.instructions.push(
    new MethodCallInstruction(undefined, entriesResult, "Add", [pairToken]),
  );

  converter.instructions.push(new LabelInstruction(loopContinue));
  converter.instructions.push(
    new BinaryOpInstruction(
      indexVar,
      indexVar,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  converter.instructions.push(new UnconditionalJumpInstruction(loopStart));
  converter.instructions.push(new LabelInstruction(loopEnd));

  return entriesResult;
};

export function visitForOfStatement(
  this: ASTToTACConverter,
  node: ForOfStatementNode,
): void {
  let iterableOperand = this.visitExpression(node.iterable);
  const inferredIterableType = resolveTypeFromNode(this, node.iterable);
  const operandType = this.getOperandType(iterableOperand);
  const inferredMapType = isMapCollectionType(operandType)
    ? operandType
    : isMapCollectionType(inferredIterableType)
      ? inferredIterableType
      : null;
  const inferredSetType = isSetCollectionType(operandType)
    ? operandType
    : isSetCollectionType(inferredIterableType)
      ? inferredIterableType
      : null;

  if (inferredMapType) {
    const entriesList = emitMapEntriesList(this, iterableOperand);
    iterableOperand = entriesList;
  } else if (inferredSetType) {
    const elementType = inferredSetType.elementType ?? ObjectType;
    const listType = new DataListTypeSymbol(elementType);
    const listResult = this.newTemp(listType);
    this.instructions.push(
      new MethodCallInstruction(listResult, iterableOperand, "GetKeys", []),
    );
    iterableOperand = listResult;
  }

  const iterableType = this.getOperandType(iterableOperand);
  const inferredElementType =
    iterableType instanceof ArrayTypeSymbol
      ? iterableType.elementType
      : iterableType instanceof DataListTypeSymbol
        ? iterableType.elementType
        : iterableType?.name === ExternTypes.dataList.name
          ? ObjectType
          : null;
  // Only unwrap DataToken elements when we have a DataListTypeSymbol (e.g.,
  // Set iteration via GetKeys() yields DataListTypeSymbol) so we can use the
  // element type. When matching ExternTypes.dataList or UdonType.DataList by
  // name, elements come from DataList.get_Item as raw DataToken and must stay
  // unwrapped.
  const isDataList =
    iterableType instanceof DataListTypeSymbol ||
    iterableType.name === ExternTypes.dataList.name ||
    iterableType.udonType === UdonType.DataList;
  const indexVar = this.newTemp(PrimitiveTypes.int32);
  const lengthVar = this.newTemp(PrimitiveTypes.int32);

  const isDestructured = Array.isArray(node.variable);
  const isObjectDestructured = !!node.destructureProperties?.length;
  let elementType = isDestructured
    ? ExternTypes.dataList
    : isObjectDestructured
      ? ObjectType
      : (this.getArrayElementType(iterableOperand) ??
        inferredElementType ??
        (node.variableType
          ? this.typeMapper.mapTypeScriptType(node.variableType)
          : PrimitiveTypes.single));

  // If we're iterating an untyped `DataList` (matched by name/udonType), the
  // elements we get are raw `DataToken`s — force the loop variable to be a
  // `DataToken` so copies are well-typed. Only unwrap to concrete element
  // types when we have a `DataListTypeSymbol` carrying elementType info.
  if (isDataList && !(iterableType instanceof DataListTypeSymbol)) {
    elementType = ExternTypes.dataToken;
  }

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
      isDataList ? "Count" : "length",
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
  this.instructions.push(new ConditionalJumpInstruction(condTemp, loopEnd));

  if (isDataList) {
    const tokenValue = this.newTemp(ExternTypes.dataToken);
    this.instructions.push(
      new MethodCallInstruction(tokenValue, iterableOperand, "get_Item", [
        indexVar,
      ]),
    );
    const resolvedValue =
      iterableType instanceof DataListTypeSymbol &&
      elementType.name !== ExternTypes.dataToken.name
        ? this.unwrapDataToken(tokenValue, elementType)
        : tokenValue;
    this.instructions.push(new CopyInstruction(elementVar, resolvedValue));
  } else {
    this.instructions.push(
      new ArrayAccessInstruction(elementVar, iterableOperand, indexVar),
    );
  }
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

export function visitSwitchStatement(
  this: ASTToTACConverter,
  node: SwitchStatementNode,
): void {
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
    // Use "!=" because ConditionalJump jumps when the condition is false,
    // so we branch to the case label when values are equal.
    this.instructions.push(
      new BinaryOpInstruction(comparisonResult, switchTemp, "!=", caseValue),
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

export function visitDoWhileStatement(
  this: ASTToTACConverter,
  node: DoWhileStatementNode,
): void {
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
  this.instructions.push(new ConditionalJumpInstruction(condition, endLabel));
  this.instructions.push(new UnconditionalJumpInstruction(startLabel));
  this.instructions.push(new LabelInstruction(endLabel));
}

export function visitBreakStatement(
  this: ASTToTACConverter,
  _node: BreakStatementNode,
): void {
  const context = this.loopContextStack[this.loopContextStack.length - 1];
  if (!context) {
    throw new Error("Break statement used outside of loop or switch");
  }
  this.instructions.push(new UnconditionalJumpInstruction(context.breakLabel));
}

export function visitContinueStatement(
  this: ASTToTACConverter,
  _node: ContinueStatementNode,
): void {
  const context = this.loopContextStack[this.loopContextStack.length - 1];
  if (!context) {
    throw new Error("Continue statement used outside of loop");
  }
  this.instructions.push(
    new UnconditionalJumpInstruction(context.continueLabel),
  );
}

export function visitReturnStatement(
  this: ASTToTACConverter,
  node: ReturnStatementNode,
): void {
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

export function visitBlockStatement(
  this: ASTToTACConverter,
  node: BlockStatementNode,
): void {
  this.symbolTable.enterScope();
  this.scanDeclarations(node.statements);
  for (const statement of node.statements) {
    this.visitStatement(statement);
  }
  this.symbolTable.exitScope();
}

export function visitInlineBlockStatement(
  this: ASTToTACConverter,
  node: BlockStatementNode,
): void {
  for (const statement of node.statements) {
    this.visitStatement(statement);
  }
}

export function visitClassDeclaration(
  this: ASTToTACConverter,
  node: ClassDeclarationNode,
): void {
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

    // Inject non-literal top-level const initialization at the start of _start/Start
    // Only for entry-point classes whose Start becomes the actual _start label
    if (
      method.name === "Start" &&
      this.pendingTopLevelInits.length > 0 &&
      this.entryPointClasses.has(node.name)
    ) {
      for (const tlc of this.pendingTopLevelInits) {
        this.visitVariableDeclaration(tlc);
      }
      this.pendingTopLevelInits = [];
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

export function visitEnumDeclaration(
  this: ASTToTACConverter,
  _node: EnumDeclarationNode,
): void {
  // enums are compile-time only
}

export function visitTryCatchStatement(
  this: ASTToTACConverter,
  node: TryCatchStatementNode,
): void {
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
    new AssignmentInstruction(errorValueVar, createConstant(null, ObjectType)),
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

export function visitThrowStatement(
  this: ASTToTACConverter,
  node: ThrowStatementNode,
): void {
  const context = this.tryContextStack[this.tryContextStack.length - 1];
  if (!context) {
    const value = this.visitExpression(node.expression);
    const externSig = this.requireExternSignature(
      "Debug",
      "LogError",
      "method",
      ["object"],
      "void",
    );
    this.instructions.push(new CallInstruction(undefined, externSig, [value]));
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
  this.instructions.push(new UnconditionalJumpInstruction(context.errorTarget));
}

export function isDestructureBlock(
  this: ASTToTACConverter,
  node: BlockStatementNode,
): boolean {
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

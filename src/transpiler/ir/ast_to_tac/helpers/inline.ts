import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ExternTypes,
  ObjectType,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";
import {
  type ASTNode,
  ASTNodeKind,
  type AsExpressionNode,
  type AssignmentExpressionNode,
  type BinaryExpressionNode,
  type BlockStatementNode,
  type CallExpressionNode,
  type DoWhileStatementNode,
  type ForOfStatementNode,
  type ForStatementNode,
  type IfStatementNode,
  type PropertyAccessExpressionNode,
  type ReturnStatementNode,
  type SwitchStatementNode,
  type UnaryExpressionNode,
  type VariableDeclarationNode,
  type WhileStatementNode,
} from "../../../frontend/types.js";
import {
  ArrayAccessInstruction,
  ArrayAssignmentInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  CopyInstruction,
  LabelInstruction,
} from "../../tac_instruction.js";
import {
  createConstant,
  createVariable,
  type TACOperand,
  TACOperandKind,
  type VariableOperand,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

export function visitInlineConstructor(
  this: ASTToTACConverter,
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

  let classNode = this.classMap.get(className);
  if (!classNode && this.classRegistry) {
    const meta = this.classRegistry.getClass(className);
    if (
      meta &&
      !this.udonBehaviourClasses.has(className) &&
      !this.classRegistry.isStub(className)
    ) {
      classNode = meta.node;
      this.classMap.set(className, classNode);
    }
  }
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
    const propVar = createVariable(`${instancePrefix}_${prop.name}`, prop.type);
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

export function visitInlineStaticMethodCall(
  this: ASTToTACConverter,
  className: string,
  methodName: string,
  args: TACOperand[],
): TACOperand | null {
  const inlineKey = `${className}.${methodName}`;
  if (this.inlineStaticMethodStack.has(inlineKey)) {
    return null;
  }
  let classNode = this.classMap.get(className);
  if (!classNode && this.classRegistry) {
    const meta = this.classRegistry.getClass(className);
    if (meta && !this.classRegistry.isStub(className)) {
      classNode = meta.node;
      this.classMap.set(className, classNode);
    }
  }
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

export function visitInlineInstanceMethodCall(
  this: ASTToTACConverter,
  className: string,
  methodName: string,
  args: TACOperand[],
): TACOperand | null {
  const inlineKey = `${className}::${methodName}`;
  if (this.inlineStaticMethodStack.has(inlineKey)) {
    return null; // recursion detected → fallback
  }
  let classNode = this.classMap.get(className);
  if (!classNode && this.classRegistry) {
    const meta = this.classRegistry.getClass(className);
    if (meta && !this.classRegistry.isStub(className)) {
      classNode = meta.node;
      this.classMap.set(className, classNode);
    }
  }
  if (!classNode) return null;
  const method = classNode.methods.find(
    (candidate) => candidate.name === methodName && !candidate.isStatic,
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

export function maybeTrackInlineInstanceAssignment(
  this: ASTToTACConverter,
  target: VariableOperand,
  value: TACOperand,
): void {
  if (value.kind !== TACOperandKind.Variable) return;
  const mapped = this.inlineInstanceMap.get((value as VariableOperand).name);
  if (mapped) {
    this.inlineInstanceMap.set(target.name, mapped);
  }
}

export function mapInlineProperty(
  this: ASTToTACConverter,
  className: string,
  instancePrefix: string,
  property: string,
): VariableOperand | undefined {
  const classNode = this.classMap.get(className);
  const prop = classNode?.properties.find((p) => p.name === property);
  if (!prop) return undefined;
  return createVariable(`${instancePrefix}_${property}`, prop.type);
}

export function tryResolveUnitySelfReference(
  this: ASTToTACConverter,
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

export function collectRecursiveLocals(
  this: ASTToTACConverter,
  method: {
    parameters: Array<{ name: string; type: TypeSymbol }>;
    body: BlockStatementNode;
  },
): Array<{ name: string; type: TypeSymbol }> {
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
        if (Array.isArray(forOfNode.variable)) {
          for (const name of forOfNode.variable) {
            locals.set(name, ObjectType);
          }
        } else {
          const mappedType = forOfNode.variableType
            ? this.typeMapper.mapTypeScriptType(forOfNode.variableType)
            : ObjectType;
          locals.set(forOfNode.variable, mappedType);
        }
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

export function emitRecursivePrologue(this: ASTToTACConverter): void {
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

export function emitRecursiveEpilogue(this: ASTToTACConverter): void {
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

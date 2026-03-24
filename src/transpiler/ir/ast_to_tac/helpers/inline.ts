import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ExternTypes,
  InterfaceTypeSymbol,
  ObjectType,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";

/**
 * Maximum recursion depth for @RecursiveMethod. Shared between stack
 * allocation (statement.ts) and the overflow guard (emitCallSitePush).
 */
export const MAX_RECURSION_STACK_DEPTH = 16;

import {
  type ArrayAccessExpressionNode,
  type ArrayLiteralExpressionNode,
  type ASTNode,
  ASTNodeKind,
  type AsExpressionNode,
  type AssignmentExpressionNode,
  type BinaryExpressionNode,
  type BlockStatementNode,
  type CallExpressionNode,
  type ClassDeclarationNode,
  type ConditionalExpressionNode,
  type DeleteExpressionNode,
  type DoWhileStatementNode,
  type ForOfStatementNode,
  type ForStatementNode,
  type IfStatementNode,
  type NullCoalescingExpressionNode,
  type ObjectLiteralExpressionNode,
  type OptionalChainingExpressionNode,
  type PropertyAccessExpressionNode,
  type ReturnStatementNode,
  type SwitchStatementNode,
  type TemplateExpressionNode,
  type ThrowStatementNode,
  type TryCatchStatementNode,
  type UnaryExpressionNode,
  type UpdateExpressionNode,
  type VariableDeclarationNode,
  type WhileStatementNode,
} from "../../../frontend/types.js";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  MethodCallInstruction,
  ReturnInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  createConstant,
  createLabel,
  createVariable,
  type TACOperand,
  TACOperandKind,
  type VariableOperand,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

type InlineParamSave = Map<
  string,
  { prefix: string; className: string } | undefined
>;

function saveAndBindInlineParams(
  converter: ASTToTACConverter,
  params: Array<{ name: string; type: TypeSymbol }>,
  args: TACOperand[],
): InlineParamSave {
  const argInlineInfos = args.map((arg) =>
    arg && arg.kind === TACOperandKind.Variable
      ? converter.resolveInlineInstance((arg as VariableOperand).name)
      : undefined,
  );
  const saved: InlineParamSave = new Map();
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    if (!converter.symbolTable.hasInCurrentScope(param.name)) {
      converter.symbolTable.addSymbol(param.name, param.type, true, false);
    }
    saved.set(param.name, converter.inlineInstanceMap.get(param.name));
    converter.inlineInstanceMap.delete(param.name);
    if (args[i]) {
      converter.instructions.push(
        new CopyInstruction(
          createVariable(param.name, param.type, { isParameter: true }),
          args[i],
        ),
      );
      const argInfo = argInlineInfos[i];
      if (argInfo) {
        converter.inlineInstanceMap.set(param.name, argInfo);
      }
    }
  }
  return saved;
}

function restoreInlineParams(
  converter: ASTToTACConverter,
  saved: InlineParamSave,
): void {
  for (const [name, entry] of saved) {
    if (entry === undefined) {
      converter.inlineInstanceMap.delete(name);
    } else {
      converter.inlineInstanceMap.set(name, entry);
    }
  }
}

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
  const instanceId = this.nextInstanceId++;
  const instanceHandle = createVariable(
    `${instancePrefix}__handle`,
    PrimitiveTypes.int32,
  );
  this.instructions.push(
    new AssignmentInstruction(
      instanceHandle,
      createConstant(instanceId, PrimitiveTypes.int32),
    ),
  );
  this.inlineInstanceMap.set(instanceHandle.name, {
    prefix: instancePrefix,
    className,
  });
  this.allInlineInstances.set(instanceId, {
    prefix: instancePrefix,
    className,
  });

  // Register classId for interfaces this class implements
  if (classNode.implements) {
    for (const ifaceName of classNode.implements) {
      if (!this.interfaceClassIdMap.has(ifaceName)) {
        this.interfaceClassIdMap.set(ifaceName, new Map());
      }
      const classIds = this.interfaceClassIdMap.get(ifaceName);
      if (classIds && !classIds.has(className)) {
        classIds.set(className, classIds.size);
      }
    }
  }

  for (const prop of classNode.properties) {
    if (!prop.initializer) continue;
    const previousSerializeFieldState = this.inSerializeFieldInitializer;
    this.inSerializeFieldInitializer = !!prop.isSerializeField;
    const propVar = createVariable(`${instancePrefix}_${prop.name}`, prop.type);
    const value = this.visitExpression(prop.initializer);
    this.inSerializeFieldInitializer = previousSerializeFieldState;
    this.instructions.push(new AssignmentInstruction(propVar, value));
    this.maybeTrackInlineInstanceAssignment(propVar, value);
  }

  if (classNode.constructor) {
    this.symbolTable.enterScope();
    const typedParams = classNode.constructor.parameters.map((p) => ({
      name: p.name,
      type: this.typeMapper.mapTypeScriptType(p.type),
    }));
    const savedParamEntries = saveAndBindInlineParams(this, typedParams, args);
    const previousContext = this.currentInlineContext;
    const previousThisOverride = this.currentThisOverride;
    this.currentInlineContext = { className, instancePrefix };
    this.currentThisOverride = null;
    try {
      this.visitStatement(classNode.constructor.body);
    } finally {
      this.currentInlineContext = previousContext;
      this.currentThisOverride = previousThisOverride;
      restoreInlineParams(this, savedParamEntries);
      this.symbolTable.exitScope();
    }
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
  if (this.inlineMethodStack.has(inlineKey)) {
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
  const result = createVariable(
    `__inline_ret_${this.tempCounter++}`,
    returnType,
    { isLocal: true },
  );
  const returnLabel = this.newLabel("inline_return");

  this.symbolTable.enterScope();
  const savedParamEntries = saveAndBindInlineParams(
    this,
    method.parameters,
    args,
  );

  const savedParamExportMap = this.currentParamExportMap;
  const savedParamExportReverseMap = this.currentParamExportReverseMap;
  const savedMethodLayout = this.currentMethodLayout;
  const savedInlineContext = this.currentInlineContext;
  const savedThisOverride = this.currentThisOverride;
  this.currentParamExportMap = new Map();
  this.currentParamExportReverseMap = new Map();
  this.currentMethodLayout = null;
  this.currentInlineContext = undefined;
  this.currentThisOverride = null;

  this.inlineMethodStack.add(inlineKey);
  this.inlineReturnStack.push({
    returnVar: result,
    returnLabel,
    returnTrackingInvalidated: false,
    loopDepth: this.loopContextStack.length,
  });
  try {
    this.visitBlockStatement(method.body);
  } finally {
    this.inlineReturnStack.pop();
    this.inlineMethodStack.delete(inlineKey);
    this.currentParamExportMap = savedParamExportMap;
    this.currentParamExportReverseMap = savedParamExportReverseMap;
    this.currentMethodLayout = savedMethodLayout;
    this.currentInlineContext = savedInlineContext;
    this.currentThisOverride = savedThisOverride;
    restoreInlineParams(this, savedParamEntries);
    this.symbolTable.exitScope();
  }

  this.instructions.push(new LabelInstruction(returnLabel));
  return result;
}

/**
 * Shared implementation for instance method inlining.
 * When instancePrefix is provided, sets currentInlineContext;
 * otherwise clears it.
 */
function inlineInstanceMethodCallCore(
  converter: ASTToTACConverter,
  className: string,
  methodName: string,
  args: TACOperand[],
  instancePrefix: string | undefined,
): TACOperand | null {
  const inlineKey = `${className}::${methodName}`;
  if (converter.inlineMethodStack.has(inlineKey)) {
    return null; // recursion detected → fallback
  }
  let classNode = converter.classMap.get(className);
  if (!classNode && converter.classRegistry) {
    const meta = converter.classRegistry.getClass(className);
    if (meta && !converter.classRegistry.isStub(className)) {
      classNode = meta.node;
      converter.classMap.set(className, classNode);
    }
  }
  if (!classNode) return null;
  const method = classNode.methods.find(
    (candidate) => candidate.name === methodName && !candidate.isStatic,
  );
  if (!method) return null;

  const returnType = method.returnType;
  const result = createVariable(
    `__inline_ret_${converter.tempCounter++}`,
    returnType,
    { isLocal: true },
  );
  const returnLabel = converter.newLabel("inline_return");

  converter.symbolTable.enterScope();
  const savedParamEntries = saveAndBindInlineParams(
    converter,
    method.parameters,
    args,
  );

  const savedParamExportMap = converter.currentParamExportMap;
  const savedParamExportReverseMap = converter.currentParamExportReverseMap;
  const savedMethodLayout = converter.currentMethodLayout;
  const savedInlineContext = converter.currentInlineContext;
  const savedThisOverride = converter.currentThisOverride;
  converter.currentParamExportMap = new Map();
  converter.currentParamExportReverseMap = new Map();
  converter.currentMethodLayout = null;
  converter.currentThisOverride = null;
  converter.currentInlineContext = instancePrefix
    ? { className, instancePrefix }
    : undefined;

  converter.inlineMethodStack.add(inlineKey);
  converter.inlineReturnStack.push({
    returnVar: result,
    returnLabel,
    returnTrackingInvalidated: false,
    loopDepth: converter.loopContextStack.length,
  });
  try {
    converter.visitBlockStatement(method.body);
  } finally {
    converter.inlineReturnStack.pop();
    converter.inlineMethodStack.delete(inlineKey);
    converter.currentParamExportMap = savedParamExportMap;
    converter.currentParamExportReverseMap = savedParamExportReverseMap;
    converter.currentMethodLayout = savedMethodLayout;
    converter.currentInlineContext = savedInlineContext;
    converter.currentThisOverride = savedThisOverride;
    restoreInlineParams(converter, savedParamEntries);
    converter.symbolTable.exitScope();
  }

  converter.instructions.push(new LabelInstruction(returnLabel));
  return result;
}

export function visitInlineInstanceMethodCall(
  this: ASTToTACConverter,
  className: string,
  methodName: string,
  args: TACOperand[],
): TACOperand | null {
  return inlineInstanceMethodCallCore(
    this,
    className,
    methodName,
    args,
    undefined,
  );
}

export function visitInlineInstanceMethodCallWithContext(
  this: ASTToTACConverter,
  className: string,
  instancePrefix: string,
  methodName: string,
  args: TACOperand[],
): TACOperand | null {
  return inlineInstanceMethodCallCore(
    this,
    className,
    methodName,
    args,
    instancePrefix,
  );
}

/**
 * Emit property initializers and constructor body for an entry-point class.
 * Shared by visitClassDeclaration (Start method path) and generateEntryPoint (no-Start path).
 */
export function emitEntryPointPropertyInit(
  this: ASTToTACConverter,
  classNode: ClassDeclarationNode,
): void {
  for (const prop of classNode.properties) {
    if (!prop.initializer || prop.isStatic) continue;
    const previousSerializeFieldState = this.inSerializeFieldInitializer;
    this.inSerializeFieldInitializer = !!prop.isSerializeField;
    const value = this.visitExpression(prop.initializer);
    this.inSerializeFieldInitializer = previousSerializeFieldState;
    const targetVar = createVariable(
      this.entryPointPropName(prop.name),
      prop.type,
    );
    this.instructions.push(new CopyInstruction(targetVar, value));
    this.maybeTrackInlineInstanceAssignment(targetVar, value);
  }
  if (classNode.constructor?.body) {
    const nonSerializeFieldParams = classNode.constructor.parameters.filter(
      (p) => !p.isSerializeField,
    );
    if (nonSerializeFieldParams.length > 0) {
      throw new Error(
        `Entry-point class "${classNode.name}" constructor must be parameterless`,
      );
    }
    this.symbolTable.enterScope();
    try {
      // Register @SerializeField params so the constructor body can reference them
      for (const param of classNode.constructor.parameters) {
        if (!param.isSerializeField) continue;
        const paramType = this.typeMapper.mapTypeScriptType(param.type);
        this.symbolTable.addSymbol(param.name, paramType, true, false);
      }
      this.visitStatement(classNode.constructor.body);
    } finally {
      this.symbolTable.exitScope();
    }
  }
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

/**
 * Look up inline instance info by variable name, bridging raw ↔ export names.
 *
 * Tries three lookups in order:
 * 1. Direct: `inlineInstanceMap.get(name)`
 * 2. Forward: name is a raw param → look up its export name
 * 3. Reverse: name is an export name → find the corresponding raw param name
 *
 * Reverse lookup uses currentParamExportReverseMap for O(1) export → raw lookup.
 */
export function resolveInlineInstance(
  this: ASTToTACConverter,
  name: string,
): { prefix: string; className: string } | undefined {
  const direct = this.inlineInstanceMap.get(name);
  if (direct) return direct;
  const exportName = this.currentParamExportMap.get(name);
  if (exportName) {
    const byExport = this.inlineInstanceMap.get(exportName);
    if (byExport) return byExport;
  }
  const rawName = this.currentParamExportReverseMap.get(name);
  if (rawName) {
    return this.inlineInstanceMap.get(rawName);
  }
  return undefined;
}

export function mapInlineProperty(
  this: ASTToTACConverter,
  className: string,
  instancePrefix: string,
  property: string,
): VariableOperand | undefined {
  const classNode = this.classMap.get(className);
  const prop = classNode?.properties.find((p) => p.name === property);
  if (prop) return createVariable(`${instancePrefix}_${property}`, prop.type);

  // Fallback: InterfaceTypeSymbol from type alias
  const alias = this.typeMapper.getAlias(className);
  if (alias instanceof InterfaceTypeSymbol) {
    const propType = alias.properties.get(property);
    if (propType)
      return createVariable(`${instancePrefix}_${property}`, propType);
  }

  // Fallback: InterfaceMetadata from classRegistry
  if (this.classRegistry) {
    const iface = this.classRegistry.getInterface(className);
    if (iface) {
      const ifaceProp = iface.properties.find((p) => p.name === property);
      if (ifaceProp)
        return createVariable(
          `${instancePrefix}_${property}`,
          this.typeMapper.mapTypeScriptType(ifaceProp.type),
        );
    }
  }
  return undefined;
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
        if (forOfNode.destructureProperties) {
          for (const entry of forOfNode.destructureProperties) {
            locals.set(entry.name, ObjectType);
          }
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
      case ASTNodeKind.TryCatchStatement: {
        const tryNode = node as TryCatchStatementNode;
        visitNode(tryNode.tryBody);
        if (tryNode.catchVariable) {
          locals.set(tryNode.catchVariable, ObjectType);
        }
        if (tryNode.catchBody) visitNode(tryNode.catchBody);
        if (tryNode.finallyBody) visitNode(tryNode.finallyBody);
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
      case ASTNodeKind.ConditionalExpression: {
        const condNode = node as ConditionalExpressionNode;
        visitNode(condNode.condition);
        visitNode(condNode.whenTrue);
        visitNode(condNode.whenFalse);
        break;
      }
      case ASTNodeKind.NullCoalescingExpression: {
        const nullCoalesce = node as NullCoalescingExpressionNode;
        visitNode(nullCoalesce.left);
        visitNode(nullCoalesce.right);
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
      case ASTNodeKind.ThrowStatement: {
        const throwNode = node as ThrowStatementNode;
        visitNode(throwNode.expression);
        break;
      }
      case ASTNodeKind.AsExpression: {
        const asNode = node as AsExpressionNode;
        visitNode(asNode.expression);
        break;
      }
      case ASTNodeKind.FunctionExpression: {
        // Do NOT recurse into closure bodies: variables declared inside a
        // closure are not part of the enclosing method's recursion locals.
        break;
      }
      case ASTNodeKind.ArrayLiteralExpression: {
        const arrNode = node as ArrayLiteralExpressionNode;
        for (const elem of arrNode.elements) visitNode(elem.value);
        break;
      }
      case ASTNodeKind.ArrayAccessExpression: {
        const accNode = node as ArrayAccessExpressionNode;
        visitNode(accNode.array);
        visitNode(accNode.index);
        break;
      }
      case ASTNodeKind.TemplateExpression: {
        const tmplNode = node as TemplateExpressionNode;
        for (const part of tmplNode.parts) {
          if (part.kind === "expression") visitNode(part.expression);
        }
        break;
      }
      case ASTNodeKind.ObjectLiteralExpression: {
        const objNode = node as ObjectLiteralExpressionNode;
        for (const prop of objNode.properties) visitNode(prop.value);
        break;
      }
      case ASTNodeKind.DeleteExpression: {
        const delNode = node as DeleteExpressionNode;
        visitNode(delNode.target);
        break;
      }
      case ASTNodeKind.OptionalChainingExpression: {
        const optNode = node as OptionalChainingExpressionNode;
        visitNode(optNode.object);
        break;
      }
      case ASTNodeKind.UpdateExpression: {
        const updNode = node as UpdateExpressionNode;
        visitNode(updNode.operand);
        break;
      }
      default:
        break;
    }
  };

  visitNode(method.body);
  return Array.from(locals.entries()).map(([name, type]) => ({ name, type }));
}

/**
 * Push all locals onto per-local DataList stacks at the current SP.
 * Used at each self-call site BEFORE the JUMP to the recursive method.
 * Increments SP first, then saves all locals at the new SP index.
 */
export function emitCallSitePush(this: ASTToTACConverter): void {
  const context = this.currentRecursiveContext;
  if (!context) return;

  const spVar = createVariable(context.spVar, PrimitiveTypes.int32);

  // Guard: abort if depth has reached MAX_RECURSION_STACK_DEPTH.
  // Without this, set_Item would write beyond the pre-populated DataList bounds.
  // ConditionalJumpInstruction is "ifFalse goto", so we check (depth < MAX)
  // and jump to the shared overflow handler (emitted once in the method
  // prologue) when false (i.e., depth >= MAX).
  const depthVar = createVariable(context.depthVar, PrimitiveTypes.int32);
  const depthOk = this.newTemp(PrimitiveTypes.boolean);
  this.instructions.push(
    new BinaryOpInstruction(
      depthOk,
      depthVar,
      "<",
      createConstant(MAX_RECURSION_STACK_DEPTH, PrimitiveTypes.int32),
    ),
  );
  this.instructions.push(
    new ConditionalJumpInstruction(depthOk, context.overflowLabel),
  );

  // SP++
  const spTemp = this.newTemp(PrimitiveTypes.int32);
  this.instructions.push(
    new BinaryOpInstruction(
      spTemp,
      spVar,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  this.instructions.push(new CopyInstruction(spVar, spTemp));

  // Save each local at stack[SP]
  for (let index = 0; index < context.locals.length; index++) {
    const local = context.locals[index];
    const stackVarInfo = context.stackVars[index];
    const stackVar = createVariable(stackVarInfo.name, ExternTypes.dataList);
    const localVar = createVariable(local.name, local.type, {
      isLocal: true,
    });
    const token = this.wrapDataToken(localVar);
    this.instructions.push(
      new MethodCallInstruction(undefined, stackVar, "set_Item", [
        spVar,
        token,
      ]),
    );
  }
}

/**
 * Pop all locals from per-local DataList stacks at the current SP.
 * Used at each self-call site AFTER the return label (after reading the return value).
 * Restores all locals from the current SP index, then decrements SP.
 */
export function emitCallSitePop(this: ASTToTACConverter): void {
  const context = this.currentRecursiveContext;
  if (!context) return;

  const spVar = createVariable(context.spVar, PrimitiveTypes.int32);

  // Guard: SP must be >= 0 before pop (mirrors the depth guard in push).
  // If this fires it indicates a push/pop imbalance in code-gen.
  // ConditionalJumpInstruction is "ifFalse goto", so we check (SP >= 0)
  // and jump to the underflow handler when false (i.e., SP < 0).
  const spOk = this.newTemp(PrimitiveTypes.boolean);
  this.instructions.push(
    new BinaryOpInstruction(
      spOk,
      spVar,
      ">=",
      createConstant(0, PrimitiveTypes.int32),
    ),
  );
  const underflowLabel = this.newLabel("pop_underflow");
  const afterPopLabel = this.newLabel("after_pop");
  this.instructions.push(new ConditionalJumpInstruction(spOk, underflowLabel));

  // Restore each local from stack[SP]
  for (let index = 0; index < context.locals.length; index++) {
    const local = context.locals[index];
    const stackVarInfo = context.stackVars[index];
    const stackVar = createVariable(stackVarInfo.name, ExternTypes.dataList);
    const token = this.newTemp(ExternTypes.dataToken);
    this.instructions.push(
      new MethodCallInstruction(token, stackVar, "get_Item", [spVar]),
    );
    const unwrapped = this.unwrapDataToken(token, local.type);
    this.instructions.push(
      new CopyInstruction(
        createVariable(local.name, local.type, { isLocal: true }),
        unwrapped,
      ),
    );
  }

  // SP--
  const spTemp = this.newTemp(PrimitiveTypes.int32);
  this.instructions.push(
    new BinaryOpInstruction(
      spTemp,
      spVar,
      "-",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  this.instructions.push(new CopyInstruction(spVar, spTemp));
  this.instructions.push(new UnconditionalJumpInstruction(afterPopLabel));

  // Underflow handler: log error and skip restore
  this.instructions.push(new LabelInstruction(underflowLabel));
  const logErrorExtern = this.requireExternSignature(
    "Debug",
    "LogError",
    "method",
    ["object"],
    "void",
  );
  const underflowMsg = createConstant(
    "[udon-assembly-ts] Stack underflow: pop without matching push.",
    PrimitiveTypes.string,
  );
  this.instructions.push(
    new CallInstruction(undefined, logErrorExtern, [underflowMsg]),
  );

  this.instructions.push(new LabelInstruction(afterPopLabel));
}

/**
 * Count the number of TryCatchStatement nodes in a method body.
 * Used to predict compiler-synthesized __error_flag_* / __error_value_*
 * variable names for inclusion in the recursion push/pop set.
 */
export function countTryCatchBlocks(body: BlockStatementNode): number {
  let count = 0;
  const visitNode = (node: ASTNode): void => {
    // Do not recurse into closures — they have separate try/catch scope
    if (node.kind === ASTNodeKind.FunctionExpression) return;
    if (node.kind === ASTNodeKind.TryCatchStatement) {
      count++;
      const tryNode = node as TryCatchStatementNode;
      visitNode(tryNode.tryBody);
      if (tryNode.catchBody) visitNode(tryNode.catchBody);
      if (tryNode.finallyBody) visitNode(tryNode.finallyBody);
    } else if (node.kind === ASTNodeKind.BlockStatement) {
      for (const stmt of (node as BlockStatementNode).statements) {
        visitNode(stmt);
      }
    } else if (node.kind === ASTNodeKind.IfStatement) {
      const ifNode = node as IfStatementNode;
      visitNode(ifNode.thenBranch);
      if (ifNode.elseBranch) visitNode(ifNode.elseBranch);
    } else if (node.kind === ASTNodeKind.WhileStatement) {
      visitNode((node as WhileStatementNode).body);
    } else if (node.kind === ASTNodeKind.DoWhileStatement) {
      visitNode((node as DoWhileStatementNode).body);
    } else if (node.kind === ASTNodeKind.ForStatement) {
      visitNode((node as ForStatementNode).body);
    } else if (node.kind === ASTNodeKind.ForOfStatement) {
      visitNode((node as ForOfStatementNode).body);
    } else if (node.kind === ASTNodeKind.SwitchStatement) {
      for (const c of (node as SwitchStatementNode).cases) {
        for (const stmt of c.statements) visitNode(stmt);
      }
    }
  };
  visitNode(body);
  return count;
}

/**
 * Count the number of self-recursive calls (this.methodName(...)) in a method body.
 * Used to pre-allocate selfCallResult variables that survive across sibling calls.
 */
export function countSelfCalls(
  methodName: string,
  body: BlockStatementNode,
): number {
  let count = 0;
  const visitNode = (node: ASTNode): void => {
    switch (node.kind) {
      case ASTNodeKind.CallExpression: {
        const callNode = node as CallExpressionNode;
        if (callNode.callee.kind === ASTNodeKind.PropertyAccessExpression) {
          const propAccess = callNode.callee as PropertyAccessExpressionNode;
          if (
            propAccess.object.kind === ASTNodeKind.ThisExpression &&
            propAccess.property === methodName
          ) {
            count++;
          }
        }
        visitNode(callNode.callee);
        for (const arg of callNode.arguments) visitNode(arg);
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
      case ASTNodeKind.TryCatchStatement: {
        const tryNode = node as TryCatchStatementNode;
        visitNode(tryNode.tryBody);
        if (tryNode.catchBody) visitNode(tryNode.catchBody);
        if (tryNode.finallyBody) visitNode(tryNode.finallyBody);
        break;
      }
      case ASTNodeKind.ReturnStatement: {
        const retNode = node as ReturnStatementNode;
        if (retNode.value) visitNode(retNode.value);
        break;
      }
      case ASTNodeKind.ThrowStatement: {
        const throwNode = node as ThrowStatementNode;
        visitNode(throwNode.expression);
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
      case ASTNodeKind.ConditionalExpression: {
        const condNode = node as ConditionalExpressionNode;
        visitNode(condNode.condition);
        visitNode(condNode.whenTrue);
        visitNode(condNode.whenFalse);
        break;
      }
      case ASTNodeKind.NullCoalescingExpression: {
        const nullCoalesce = node as NullCoalescingExpressionNode;
        visitNode(nullCoalesce.left);
        visitNode(nullCoalesce.right);
        break;
      }
      case ASTNodeKind.AssignmentExpression: {
        const assignNode = node as AssignmentExpressionNode;
        visitNode(assignNode.target);
        visitNode(assignNode.value);
        break;
      }
      case ASTNodeKind.VariableDeclaration: {
        const varNode = node as VariableDeclarationNode;
        if (varNode.initializer) visitNode(varNode.initializer);
        break;
      }
      case ASTNodeKind.PropertyAccessExpression: {
        const propNode = node as PropertyAccessExpressionNode;
        visitNode(propNode.object);
        break;
      }
      case ASTNodeKind.AsExpression: {
        const asNode = node as AsExpressionNode;
        visitNode(asNode.expression);
        break;
      }
      case ASTNodeKind.FunctionExpression: {
        // Do NOT recurse into closure bodies: self-calls inside a closure
        // go through a different runtime path and should not count toward
        // the __selfCallResult_* pre-allocation for the enclosing method.
        break;
      }
      case ASTNodeKind.ArrayLiteralExpression: {
        const arrNode = node as ArrayLiteralExpressionNode;
        for (const elem of arrNode.elements) visitNode(elem.value);
        break;
      }
      case ASTNodeKind.ArrayAccessExpression: {
        const accNode = node as ArrayAccessExpressionNode;
        visitNode(accNode.array);
        visitNode(accNode.index);
        break;
      }
      case ASTNodeKind.TemplateExpression: {
        const tmplNode = node as TemplateExpressionNode;
        for (const part of tmplNode.parts) {
          if (part.kind === "expression") visitNode(part.expression);
        }
        break;
      }
      case ASTNodeKind.ObjectLiteralExpression: {
        const objNode = node as ObjectLiteralExpressionNode;
        for (const prop of objNode.properties) visitNode(prop.value);
        break;
      }
      case ASTNodeKind.DeleteExpression: {
        const delNode = node as DeleteExpressionNode;
        visitNode(delNode.target);
        break;
      }
      case ASTNodeKind.OptionalChainingExpression: {
        const optNode = node as OptionalChainingExpressionNode;
        visitNode(optNode.object);
        break;
      }
      case ASTNodeKind.UpdateExpression: {
        const updNode = node as UpdateExpressionNode;
        visitNode(updNode.operand);
        break;
      }
      default:
        break;
    }
  };
  visitNode(body);
  return count;
}

/**
 * Emit a dispatch table that replaces JUMP_INDIRECT for recursive returns.
 * After the epilogue restores __returnSiteIdx, this checks the index against
 * each known return site and jumps to the corresponding label.
 * If no return site matches (depth == 0, initial call), emit a normal return.
 */
export function emitReturnSiteDispatch(this: ASTToTACConverter): void {
  const context = this.currentRecursiveContext;
  if (!context) return;

  const methodName = this.currentMethodName;
  if (!methodName) return;

  if (!this.currentClassName) {
    throw new Error(
      `emitReturnSiteDispatch: missing currentClassName for method ${methodName}`,
    );
  }

  const returnSiteIdxVar = createVariable(
    `__returnSiteIdx_${this.currentClassName}_${methodName}`,
    PrimitiveTypes.int32,
    { isLocal: true },
  );
  const registryKey = `${this.currentClassName}.${methodName}`;
  const registry = this.recursiveReturnSites.get(registryKey);
  // The registry is always populated because non-recursive methods are
  // compiled before recursive ones (see orderedMethods in statement.ts).
  // Fall back to context.returnSites only for self-call-only methods
  // (no external callers registered a return site).
  const allSites = registry?.sites ?? context.returnSites;

  for (const site of allSites) {
    const cmpResult = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new BinaryOpInstruction(
        cmpResult,
        returnSiteIdxVar,
        "!=",
        createConstant(site.index, PrimitiveTypes.int32),
      ),
    );
    const siteLabel = createLabel(site.labelName);
    this.instructions.push(
      new ConditionalJumpInstruction(cmpResult, siteLabel),
    );
  }

  // Defensive fallback: should be unreachable in correct code because every
  // return-site index that can be live at method exit is registered in allSites.
  // Reached only if the method is never called (allSites is empty) or if
  // returnSiteIdx holds an unregistered value.
  this.instructions.push(
    new ReturnInstruction(undefined, this.currentReturnVar),
  );
}

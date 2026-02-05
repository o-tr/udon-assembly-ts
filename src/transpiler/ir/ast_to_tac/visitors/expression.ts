import { typeMetadataRegistry } from "../../../codegen/type_metadata_registry.js";
import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ArrayTypeSymbol,
  CollectionTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  ObjectType,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";
import {
  type ArrayAccessExpressionNode,
  type ArrayLiteralExpressionNode,
  type AssignmentExpressionNode,
  type ASTNode,
  ASTNodeKind,
  type AsExpressionNode,
  type BinaryExpressionNode,
  type CallExpressionNode,
  type ConditionalExpressionNode,
  type DeleteExpressionNode,
  type IdentifierNode,
  type LiteralNode,
  type NameofExpressionNode,
  type NullCoalescingExpressionNode,
  type ObjectLiteralExpressionNode,
  type ObjectLiteralPropertyNode,
  type OptionalChainingExpressionNode,
  type PropertyAccessExpressionNode,
  type SuperExpressionNode,
  type TemplateExpressionNode,
  type TemplatePart,
  type ThisExpressionNode,
  type TypeofExpressionNode,
  UdonType,
  type UpdateExpressionNode,
  type UnaryExpressionNode,
} from "../../../frontend/types.js";
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
  UnaryOpInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  type ConstantOperand,
  createConstant,
  createTemporary,
  createVariable,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

export function visitExpression(
  this: ASTToTACConverter,
  node: ASTNode
): TACOperand {
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

export function visitBinaryExpression(
  this: ASTToTACConverter,
  node: BinaryExpressionNode
): TACOperand {
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

export function visitShortCircuitAnd(
  this: ASTToTACConverter,
  node: BinaryExpressionNode
): TACOperand {
  const endLabel = this.newLabel("and_end");

  const left = this.visitExpression(node.left);
  const result = this.newTemp(PrimitiveTypes.boolean);
  this.instructions.push(
    new AssignmentInstruction(
      result,
      createConstant(false, PrimitiveTypes.boolean),
    ),
  );
  this.instructions.push(new ConditionalJumpInstruction(left, endLabel));

  const right = this.visitExpression(node.right);
  this.instructions.push(new CopyInstruction(result, right));
  this.instructions.push(new LabelInstruction(endLabel));
  return result;
}

export function visitShortCircuitOr(
  this: ASTToTACConverter,
  node: BinaryExpressionNode
): TACOperand {
  const result = this.newTemp(PrimitiveTypes.boolean);
  const shortCircuitLabel = this.newLabel("or_short");
  const endLabel = this.newLabel("or_end");

  const left = this.visitExpression(node.left);
  this.instructions.push(
    new ConditionalJumpInstruction(left, shortCircuitLabel),
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

export function visitUnaryExpression(
  this: ASTToTACConverter,
  node: UnaryExpressionNode
): TACOperand {
  const operand = this.visitExpression(node.operand);
  const resultType = this.getOperandType(operand);
  const result = this.newTemp(resultType);

  this.instructions.push(
    new UnaryOpInstruction(result, node.operator, operand),
  );
  return result;
}

export function visitConditionalExpression(
  this: ASTToTACConverter,
  node: ConditionalExpressionNode,
): TACOperand {
  const condition = this.visitExpression(node.condition);
  const falseLabel = this.newLabel("cond_false");
  const endLabel = this.newLabel("cond_end");

  this.instructions.push(
    new ConditionalJumpInstruction(condition, falseLabel),
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

export function visitNullCoalescingExpression(
  this: ASTToTACConverter,
  node: NullCoalescingExpressionNode,
): TACOperand {
  const left = this.visitExpression(node.left);
  const result = this.newTemp(this.getOperandType(left));
  const notNullLabel = this.newLabel("null_not");
  const endLabel = this.newLabel("null_end");

  const isNull = this.newTemp(PrimitiveTypes.boolean);
  const nullConstant = createConstant(null, ObjectType);
  this.instructions.push(
    new BinaryOpInstruction(isNull, left, "==", nullConstant),
  );
  this.instructions.push(
    new ConditionalJumpInstruction(isNull, notNullLabel),
  );

  const right = this.visitExpression(node.right);
  this.instructions.push(new CopyInstruction(result, right));
  this.instructions.push(new UnconditionalJumpInstruction(endLabel));

  this.instructions.push(new LabelInstruction(notNullLabel));
  this.instructions.push(new CopyInstruction(result, left));
  this.instructions.push(new LabelInstruction(endLabel));
  return result;
}

export function visitTemplateExpression(
  this: ASTToTACConverter,
  node: TemplateExpressionNode
): TACOperand {
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
    const concatExtern = this.requireExternSignature(
      "SystemString",
      "Concat",
      "method",
      ["string", "string"],
      "string",
    );
    this.instructions.push(
      new CallInstruction(newResult, concatExtern, [result, partOperand]),
    );
    result = newResult;
  }
  return result ?? createConstant("", PrimitiveTypes.string);
}

export function visitArrayLiteralExpression(
  this: ASTToTACConverter,
  node: ArrayLiteralExpressionNode,
): TACOperand {
  const elementType = node.typeHint
    ? this.typeMapper.mapTypeScriptType(node.typeHint)
    : ObjectType;
  const listResult = this.newTemp(new DataListTypeSymbol(elementType));
  const externSig = this.requireExternSignature(
    "DataList",
    "ctor",
    "method",
    [],
    "DataList",
  );
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

export function visitLiteral(
  this: ASTToTACConverter,
  node: LiteralNode
): TACOperand {
  return createConstant(node.value, node.type);
}

export function visitIdentifier(
  this: ASTToTACConverter,
  node: IdentifierNode
): TACOperand {
  if (node.name === "undefined") {
    return createConstant(null, ObjectType);
  }
  const symbol = this.symbolTable.lookup(node.name);
  if (!symbol) {
    if (
      this.classMap.has(node.name) ||
      typeMetadataRegistry.hasType(node.name) ||
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

export function visitArrayAccessExpression(
  this: ASTToTACConverter,
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

export function visitPropertyAccessExpression(
  this: ASTToTACConverter,
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

export function visitThisExpression(
  this: ASTToTACConverter,
  _node: ThisExpressionNode
): TACOperand {
  return createVariable("this", ObjectType);
}

export function visitSuperExpression(
  this: ASTToTACConverter,
  _node: SuperExpressionNode
): TACOperand {
  return createVariable("this", ObjectType);
}

export function visitObjectLiteralExpression(
  this: ASTToTACConverter,
  node: ObjectLiteralExpressionNode,
): TACOperand {
  const hasSpread = node.properties.some((prop) => prop.kind === "spread");
  if (!hasSpread) {
    return this.emitDictionaryFromProperties(node.properties);
  }

  const listResult = this.newTemp(ExternTypes.dataList);
  const listCtorSig = this.requireExternSignature(
    "DataList",
    "ctor",
    "method",
    [],
    "DataList",
  );
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

export function visitDeleteExpression(
  this: ASTToTACConverter,
  node: DeleteExpressionNode
): TACOperand {
  if (node.target.kind === ASTNodeKind.PropertyAccessExpression) {
    const propAccess = node.target as PropertyAccessExpressionNode;
    const object = this.visitExpression(propAccess.object);
    if (this.isUdonBehaviourPropertyAccess(propAccess)) {
      const externSig = this.requireExternSignature(
        "UdonBehaviour",
        "SetProgramVariable",
        "method",
        ["string", "object"],
        "void",
      );
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

export function visitOptionalChainingExpression(
  this: ASTToTACConverter,
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
  const notNullLabel = this.newLabel("opt_notnull");
  const endLabel = this.newLabel("opt_end");
  const result = this.newTemp(ObjectType);
  this.instructions.push(
    new ConditionalJumpInstruction(isNull, notNullLabel),
  );
  this.instructions.push(
    new AssignmentInstruction(result, createConstant(null, ObjectType)),
  );
  this.instructions.push(new UnconditionalJumpInstruction(endLabel));

  this.instructions.push(new LabelInstruction(notNullLabel));
  this.instructions.push(
    new PropertyGetInstruction(result, objTemp, node.property),
  );
  this.instructions.push(new LabelInstruction(endLabel));

  return result;
}

export function visitAsExpression(
  this: ASTToTACConverter,
  node: AsExpressionNode
): TACOperand {
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

export function visitNameofExpression(
  this: ASTToTACConverter,
  node: NameofExpressionNode
): TACOperand {
  return createConstant(node.name, PrimitiveTypes.string);
}

export function visitTypeofExpression(
  this: ASTToTACConverter,
  node: TypeofExpressionNode
): TACOperand {
  const typeNameConst = createConstant(node.typeName, PrimitiveTypes.string);
  const result = this.newTemp(ExternTypes.systemType);
  const externSig = this.requireExternSignature(
    "Type",
    "GetType",
    "method",
    ["string"],
    "Type",
  );
  this.instructions.push(
    new CallInstruction(result, externSig, [typeNameConst]),
  );
  return result;
}

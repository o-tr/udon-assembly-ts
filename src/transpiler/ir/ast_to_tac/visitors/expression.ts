import { typeMetadataRegistry } from "../../../codegen/type_metadata_registry.js";
import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ArrayTypeSymbol,
  CollectionTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  InterfaceTypeSymbol,
  ObjectType,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";
import {
  type ArrayAccessExpressionNode,
  type ArrayLiteralExpressionNode,
  type ASTNode,
  ASTNodeKind,
  type AsExpressionNode,
  type AssignmentExpressionNode,
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
  type ThisExpressionNode,
  type TypeofExpressionNode,
  UdonType,
  type UnaryExpressionNode,
  type UpdateExpressionNode,
} from "../../../frontend/types.js";
import {
  ArrayAccessInstruction,
  ArrayAssignmentInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
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
  createConstant,
  createVariable,
  type TACOperand,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

function resolvePropertyTypeFromType(
  converter: ASTToTACConverter,
  baseType: TypeSymbol,
  property: string,
): TypeSymbol | null {
  if (baseType instanceof ArrayTypeSymbol && property === "length") {
    return PrimitiveTypes.int32;
  }

  if (baseType instanceof InterfaceTypeSymbol) {
    return baseType.properties.get(property) ?? null;
  }

  if (converter.classRegistry) {
    const classMeta = converter.classRegistry.getClass(baseType.name);
    if (classMeta) {
      const prop = converter.classRegistry
        .getMergedProperties(baseType.name)
        .find((candidate) => candidate.name === property);
      if (prop) {
        return converter.typeMapper.mapTypeScriptType(prop.type);
      }
    } else {
      const interfaceMeta = converter.classRegistry.getInterface(baseType.name);
      const prop = interfaceMeta?.properties.find(
        (candidate) => candidate.name === property,
      );
      if (prop) {
        return converter.typeMapper.mapTypeScriptType(prop.type);
      }
    }
  }

  const classNode = converter.classMap.get(baseType.name);
  const prop = classNode?.properties.find(
    (candidate) => candidate.name === property,
  );
  if (prop) return prop.type;

  return null;
}

export function resolveTypeFromNode(
  converter: ASTToTACConverter,
  node: ASTNode,
): TypeSymbol | null {
  switch (node.kind) {
    case ASTNodeKind.ThisExpression:
      return converter.currentClassName
        ? converter.typeMapper.mapTypeScriptType(converter.currentClassName)
        : null;
    case ASTNodeKind.Identifier: {
      const symbol = converter.symbolTable.lookup(
        (node as IdentifierNode).name,
      );
      return symbol?.type ?? null;
    }
    case ASTNodeKind.PropertyAccessExpression: {
      const access = node as PropertyAccessExpressionNode;
      const baseType = resolveTypeFromNode(converter, access.object);
      if (!baseType) return null;
      return resolvePropertyTypeFromType(converter, baseType, access.property);
    }
    case ASTNodeKind.ArrayAccessExpression: {
      const access = node as ArrayAccessExpressionNode;
      const arrayType = resolveTypeFromNode(converter, access.array);
      if (arrayType instanceof ArrayTypeSymbol) {
        return arrayType.elementType;
      }
      if (arrayType instanceof CollectionTypeSymbol) {
        return arrayType.valueType ?? arrayType.elementType ?? ObjectType;
      }
      if (arrayType instanceof DataListTypeSymbol) {
        return arrayType.elementType;
      }
      if (arrayType?.name === ExternTypes.dataList.name) {
        return ObjectType;
      }
      return null;
    }
    default:
      return null;
  }
}

function flattenStringConcatChain(
  converter: ASTToTACConverter,
  node: BinaryExpressionNode,
): ASTNode[] | null {
  if (node.operator !== "+") return null;
  const parts: ASTNode[] = [];

  const recurse = (n: ASTNode): boolean => {
    if (n.kind === ASTNodeKind.BinaryExpression) {
      const bn = n as BinaryExpressionNode;
      if (bn.operator !== "+") return false;
      const lType = resolveTypeFromNode(converter, bn.left);
      const rType = resolveTypeFromNode(converter, bn.right);
      const lIsString = lType?.udonType === UdonType.String;
      const rIsString = rType?.udonType === UdonType.String;
      if (!lIsString && !rIsString) return false;
      if (!recurse(bn.left)) return false;
      if (!recurse(bn.right)) return false;
      return true;
    }
    parts.push(n);
    return true;
  };

  if (!recurse(node)) return null;
  return parts;
}

function generateStringBuilderConcat(
  converter: ASTToTACConverter,
  parts: TACOperand[],
): TACOperand {
  const builderType = converter.typeMapper.mapTypeScriptType("StringBuilder");
  const builder = converter.newTemp(builderType);
  const ctorSig = converter.requireExternSignature(
    "System.Text.StringBuilder",
    "ctor",
    "method",
    [],
    "System.Text.StringBuilder",
  );
  converter.instructions.push(new CallInstruction(builder, ctorSig, []));
  for (const partOperand of parts) {
    converter.instructions.push(
      new MethodCallInstruction(undefined, builder, "Append", [partOperand]),
    );
  }
  const result = converter.newTemp(PrimitiveTypes.string);
  converter.instructions.push(
    new MethodCallInstruction(result, builder, "ToString", []),
  );
  return result;
}

export function visitExpression(
  this: ASTToTACConverter,
  node: ASTNode,
): TACOperand {
  switch (node.kind) {
    case ASTNodeKind.BinaryExpression:
      return this.visitBinaryExpression(node as BinaryExpressionNode);
    case ASTNodeKind.UnaryExpression:
      return this.visitUnaryExpression(node as UnaryExpressionNode);
    case ASTNodeKind.UpdateExpression:
      return this.visitUpdateExpression(node as UpdateExpressionNode);
    case ASTNodeKind.ConditionalExpression:
      return this.visitConditionalExpression(node as ConditionalExpressionNode);
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
      return this.visitArrayAccessExpression(node as ArrayAccessExpressionNode);
    case ASTNodeKind.ThisExpression:
      return this.visitThisExpression(node as ThisExpressionNode);
    default:
      throw new Error(`Unsupported expression kind: ${node.kind}`);
  }
}

export function visitBinaryExpression(
  this: ASTToTACConverter,
  node: BinaryExpressionNode,
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
    const left = this.visitExpression(node.left);
    const right = this.visitExpression(node.right);
    const resultType = this.getOperandType(left);
    const result = this.newTemp(resultType);
    this.instructions.push(new BinaryOpInstruction(result, left, ">>", right));
    return result;
  }
  if (node.operator === "&&") {
    return this.visitShortCircuitAnd(node);
  }
  if (node.operator === "||") {
    return this.visitShortCircuitOr(node);
  }
  // Attempt to detect chained string concatenation (a + b + c ...)
  if (node.operator === "+") {
    const chain = flattenStringConcatChain(this, node);
    if (
      chain &&
      this.useStringBuilder &&
      chain.length >= this.stringBuilderThreshold
    ) {
      const partsOperands: TACOperand[] = [];
      for (const partNode of chain) {
        let partOperand: TACOperand;
        if (partNode.kind === ASTNodeKind.Literal) {
          const lit = partNode as LiteralNode;
          if (lit.type.udonType === UdonType.String) {
            const litVal = lit.value ?? "";
            if (String(litVal).length === 0) continue;
            partOperand = createConstant(String(litVal), PrimitiveTypes.string);
          } else {
            const exprResult = this.visitExpression(partNode);
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
        } else {
          const exprResult = this.visitExpression(partNode);
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
        partsOperands.push(partOperand);
      }
      if (partsOperands.length === 0) {
        return createConstant("", PrimitiveTypes.string);
      }
      return generateStringBuilderConcat(this, partsOperands);
    }
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
  node: BinaryExpressionNode,
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
  node: BinaryExpressionNode,
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
  node: UnaryExpressionNode,
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

  this.instructions.push(new ConditionalJumpInstruction(condition, falseLabel));

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
  this.instructions.push(new ConditionalJumpInstruction(isNull, notNullLabel));

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
  node: TemplateExpressionNode,
): TACOperand {
  const mergedParts = this.mergeTemplateParts(node.parts);
  const folded = this.tryFoldTemplateExpression(mergedParts);
  if (folded) {
    return folded;
  }
  const parts: TACOperand[] = [];
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
    parts.push(partOperand);
  }

  if (parts.length === 0) {
    return createConstant("", PrimitiveTypes.string);
  }

  if (this.useStringBuilder && parts.length >= this.stringBuilderThreshold) {
    const builderType = this.typeMapper.mapTypeScriptType("StringBuilder");
    const builder = this.newTemp(builderType);
    const ctorSig = this.requireExternSignature(
      "System.Text.StringBuilder",
      "ctor",
      "method",
      [],
      "System.Text.StringBuilder",
    );
    this.instructions.push(new CallInstruction(builder, ctorSig, []));
    for (const partOperand of parts) {
      this.instructions.push(
        new MethodCallInstruction(undefined, builder, "Append", [partOperand]),
      );
    }
    const result = this.newTemp(PrimitiveTypes.string);
    this.instructions.push(
      new MethodCallInstruction(result, builder, "ToString", []),
    );
    return result;
  }

  let result: TACOperand = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    const partOperand = parts[i];
    const newResult = this.newTemp(PrimitiveTypes.string);
    const concatExtern = this.requireExternSignature(
      "System.String",
      "Concat",
      "method",
      ["string", "string"],
      "System.String",
    );
    this.instructions.push(
      new CallInstruction(newResult, concatExtern, [result, partOperand]),
    );
    result = newResult;
  }
  return result;
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
      const spreadValue = this.visitExpression(element.value);
      let spreadType = this.getOperandType(spreadValue);
      let isDataList =
        spreadType.udonType === UdonType.DataList ||
        spreadType.name === ExternTypes.dataList.name;
      let isArray = spreadType.udonType === UdonType.Array;
      if (!isDataList && !isArray) {
        const resolvedType = resolveTypeFromNode(this, element.value);
        if (resolvedType) {
          if (
            resolvedType instanceof DataListTypeSymbol ||
            resolvedType.name === ExternTypes.dataList.name
          ) {
            spreadType = resolvedType;
            isDataList = true;
          } else if (resolvedType instanceof ArrayTypeSymbol) {
            spreadType = resolvedType;
            isArray = true;
          }
        }
      }
      if (!isDataList && !isArray) {
        const sourceHint =
          element.value.kind === ASTNodeKind.Identifier
            ? (element.value as IdentifierNode).name
            : String(element.value.kind);
        throw new Error(
          `Array spread expects an array or DataList (got ${spreadType.name}, ${spreadType.udonType}, from ${sourceHint})`,
        );
      }

      const indexVar = this.newTemp(PrimitiveTypes.int32);
      const lengthVar = this.newTemp(PrimitiveTypes.int32);
      this.instructions.push(
        new AssignmentInstruction(
          indexVar,
          createConstant(0, PrimitiveTypes.int32),
        ),
      );
      this.instructions.push(
        new PropertyGetInstruction(
          lengthVar,
          spreadValue,
          isDataList ? "Count" : "length",
        ),
      );

      const loopStart = this.newLabel("array_spread_start");
      const loopContinue = this.newLabel("array_spread_continue");
      const loopEnd = this.newLabel("array_spread_end");

      this.instructions.push(new LabelInstruction(loopStart));
      const condTemp = this.newTemp(PrimitiveTypes.boolean);
      this.instructions.push(
        new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
      );
      this.instructions.push(new ConditionalJumpInstruction(condTemp, loopEnd));

      const elementType = isDataList
        ? spreadType instanceof DataListTypeSymbol
          ? spreadType.elementType
          : ObjectType
        : spreadType instanceof ArrayTypeSymbol
          ? spreadType.elementType
          : (this.getArrayElementType(spreadValue) ?? ObjectType);
      const itemTemp = this.newTemp(elementType);
      if (isDataList) {
        this.instructions.push(
          new MethodCallInstruction(itemTemp, spreadValue, "get_Item", [
            indexVar,
          ]),
        );
      } else {
        this.instructions.push(
          new ArrayAccessInstruction(itemTemp, spreadValue, indexVar),
        );
      }
      const token = this.wrapDataToken(itemTemp);
      this.instructions.push(
        new MethodCallInstruction(undefined, listResult, "Add", [token]),
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
  node: LiteralNode,
): TACOperand {
  return createConstant(node.value, node.type);
}

export function visitIdentifier(
  this: ASTToTACConverter,
  node: IdentifierNode,
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

  let elementType = this.getArrayElementType(array);
  if (!elementType) {
    const resolvedArrayType = resolveTypeFromNode(this, node.array);
    if (resolvedArrayType instanceof ArrayTypeSymbol) {
      elementType = resolvedArrayType.elementType;
    } else if (resolvedArrayType instanceof CollectionTypeSymbol) {
      elementType =
        resolvedArrayType.valueType ??
        resolvedArrayType.elementType ??
        ObjectType;
    } else if (resolvedArrayType instanceof DataListTypeSymbol) {
      elementType = resolvedArrayType.elementType;
    } else if (resolvedArrayType?.name === ExternTypes.dataList.name) {
      elementType = ObjectType;
    }
  }
  const resolvedElementType = elementType ?? PrimitiveTypes.single;
  const result = this.newTemp(resolvedElementType);
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
    const objectType = this.getOperandType(object);
    let resultType: TypeSymbol | undefined;
    if (
      node.object.kind === ASTNodeKind.ThisExpression &&
      this.currentClassName
    ) {
      const classNode = this.classMap.get(this.currentClassName);
      const prop = classNode?.properties.find((p) => p.name === node.property);
      if (prop) resultType = prop.type;
    } else if (this.classRegistry) {
      const classMeta = this.classRegistry.getClass(objectType.name);
      if (classMeta) {
        const prop = this.classRegistry
          .getMergedProperties(objectType.name)
          .find((candidate) => candidate.name === node.property);
        if (prop) {
          resultType = this.typeMapper.mapTypeScriptType(prop.type);
        }
      } else {
        const interfaceMeta = this.classRegistry.getInterface(objectType.name);
        const prop = interfaceMeta?.properties.find(
          (candidate) => candidate.name === node.property,
        );
        if (prop) {
          resultType = this.typeMapper.mapTypeScriptType(prop.type);
        }
      }
    }
    if (!resultType) {
      const classNode = this.classMap.get(objectType.name);
      const prop = classNode?.properties.find((p) => p.name === node.property);
      if (prop) resultType = prop.type;
    }
    if (!resultType) {
      const baseType = resolveTypeFromNode(this, node.object);
      if (baseType) {
        resultType =
          resolvePropertyTypeFromType(this, baseType, node.property) ??
          resultType;
      }
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
  _node: ThisExpressionNode,
): TACOperand {
  const classType = this.currentClassName
    ? this.typeMapper.mapTypeScriptType(this.currentClassName)
    : ObjectType;
  return createVariable("this", classType);
}

export function visitSuperExpression(
  this: ASTToTACConverter,
  _node: SuperExpressionNode,
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
        new MethodCallInstruction(undefined, listResult, "Add", [spreadToken]),
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
  node: DeleteExpressionNode,
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

  let resultType: TypeSymbol | undefined;
  if (
    node.object.kind === ASTNodeKind.ThisExpression &&
    this.currentClassName
  ) {
    const classNode = this.classMap.get(this.currentClassName);
    const prop = classNode?.properties.find((p) => p.name === node.property);
    if (prop) resultType = prop.type;
  } else if (this.classRegistry) {
    const objectType = this.getOperandType(objTemp);
    const classMeta = this.classRegistry.getClass(objectType.name);
    if (classMeta) {
      const prop = this.classRegistry
        .getMergedProperties(objectType.name)
        .find((candidate) => candidate.name === node.property);
      if (prop) {
        resultType = this.typeMapper.mapTypeScriptType(prop.type);
      }
    } else {
      const interfaceMeta = this.classRegistry.getInterface(objectType.name);
      const prop = interfaceMeta?.properties.find(
        (candidate) => candidate.name === node.property,
      );
      if (prop) {
        resultType = this.typeMapper.mapTypeScriptType(prop.type);
      }
    }
  }

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
  const result = this.newTemp(resultType ?? ObjectType);
  this.instructions.push(new ConditionalJumpInstruction(isNull, notNullLabel));
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
  node: AsExpressionNode,
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
  node: NameofExpressionNode,
): TACOperand {
  return createConstant(node.name, PrimitiveTypes.string);
}

export function visitTypeofExpression(
  this: ASTToTACConverter,
  node: TypeofExpressionNode,
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

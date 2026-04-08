import { typeMetadataRegistry } from "../../../codegen/type_metadata_registry.js";
import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ArrayTypeSymbol,
  ClassTypeSymbol,
  CollectionTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  getPromotedType,
  InterfaceTypeSymbol,
  mapCSharpTypeToTypeSymbol,
  ObjectType,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";
import type { SymbolInfo } from "../../../frontend/types.js";
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
  needsInt32IndexCoercion,
  type ObjectLiteralExpressionNode,
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
  createConstant,
  createVariable,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";
import { emitArrayConcat } from "../helpers/assignment.js";
import {
  isMapCollectionType,
  isSetCollectionType,
} from "../helpers/collections.js";
import { resolveExternReturnType } from "../helpers/extern.js";
import {
  operandTrackingKey,
  resolveClassMethod,
  resolveClassNode,
  resolveClassProperty,
  resolveConcreteClassName,
} from "../helpers/inline.js";
import { isAllInlineInterface } from "../helpers/udon_behaviour.js";

/**
 * Try to map an inline property, falling back to concrete class resolution
 * when the className is an interface/type alias.
 */
function tryMapInlinePropertyWithConcreteFallback(
  converter: ASTToTACConverter,
  instanceInfo: { prefix: string; className: string },
  property: string,
): VariableOperand | undefined {
  const mapped = converter.mapInlineProperty(
    instanceInfo.className,
    instanceInfo.prefix,
    property,
  );
  if (mapped) return mapped;

  const concreteClass = resolveConcreteClassName(converter, instanceInfo);
  if (concreteClass !== instanceInfo.className) {
    return converter.mapInlineProperty(
      concreteClass,
      instanceInfo.prefix,
      property,
    );
  }
  return undefined;
}

/**
 * Widen operands to a common promoted numeric type when they differ.
 * Returns the (possibly widened) operands.
 */
function widenNumericOperands(
  converter: ASTToTACConverter,
  left: TACOperand,
  right: TACOperand,
): { left: TACOperand; right: TACOperand } {
  const leftSym = converter.getOperandType(left);
  const rightSym = converter.getOperandType(right);
  if (leftSym.udonType === rightSym.udonType) {
    return { left, right };
  }
  const promoted = getPromotedType(leftSym, rightSym);
  if (!promoted) {
    return { left, right };
  }
  let newLeft = left;
  let newRight = right;
  if (leftSym.udonType !== promoted.udonType) {
    const w = converter.newTemp(promoted);
    converter.instructions.push(new CastInstruction(w, left));
    newLeft = w;
  }
  if (rightSym.udonType !== promoted.udonType) {
    const w = converter.newTemp(promoted);
    converter.instructions.push(new CastInstruction(w, right));
    newRight = w;
  }
  return { left: newLeft, right: newRight };
}

const BITWISE_FLOAT_TYPES: ReadonlySet<UdonType> = new Set([
  UdonType.Single,
  UdonType.Double,
]);

/**
 * Narrow floating-point operands to Int32 for bitwise operators (|, &, ^).
 * Udon VM has no bitwise ops on Single/Double; applying them generates
 * invalid EXTERNs like SystemSingle.__op_LogicalOr__. Other integer types
 * (Int16, UInt32, etc.) are left unchanged — they either have native
 * bitwise support or will fail at codegen with a clear extern-not-found error.
 */
function narrowToInt32ForBitwise(
  converter: ASTToTACConverter,
  left: TACOperand,
  right: TACOperand,
): { left: TACOperand; right: TACOperand } {
  const leftType = converter.getOperandType(left);
  const rightType = converter.getOperandType(right);
  let newLeft = left;
  let newRight = right;
  if (BITWISE_FLOAT_TYPES.has(leftType.udonType)) {
    const cast = converter.newTemp(PrimitiveTypes.int32);
    converter.instructions.push(new CastInstruction(cast, left));
    newLeft = cast;
  }
  if (BITWISE_FLOAT_TYPES.has(rightType.udonType)) {
    const cast = converter.newTemp(PrimitiveTypes.int32);
    converter.instructions.push(new CastInstruction(cast, right));
    newRight = cast;
  }
  return { left: newLeft, right: newRight };
}

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

  // Consult type metadata registry for extern/stub types (e.g. DataToken, DataList)
  const metadata = typeMetadataRegistry.getMemberMetadata(
    baseType.name,
    property,
  );
  if (metadata && metadata.kind === "property") {
    return mapCSharpTypeToTypeSymbol(metadata.returnCsharpType);
  }

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
      // If the symbol has a concrete/non-generic type, return it. Otherwise
      // fall back to resolving from the initializer AST when available.
      if (symbol?.type && symbol.type !== ObjectType) return symbol.type;
      if (symbol?.initialValue) {
        return resolveTypeFromNode(converter, symbol.initialValue as ASTNode);
      }
      return null;
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
    case ASTNodeKind.CallExpression: {
      // Resolve the return type of a call expression from the callee's
      // method declaration. Handles `ClassName.method()` and `obj.method()`.
      const call = node as CallExpressionNode;
      if (call.callee.kind === ASTNodeKind.PropertyAccessExpression) {
        const pa = call.callee as PropertyAccessExpressionNode;
        const baseType = resolveTypeFromNode(converter, pa.object);
        if (baseType && baseType !== ObjectType) {
          const ret = resolveMethodReturnType(converter, baseType, pa.property);
          if (ret) return ret;
        }
        // Static method on a class name: e.g. Tile.parse("1m")
        // Check classMap/classRegistry directly since typeMapper may map
        // inline class names to ObjectType.
        if (pa.object.kind === ASTNodeKind.Identifier) {
          const className = (pa.object as IdentifierNode).name;
          const isKnownClass =
            converter.classMap.has(className) ||
            !!converter.classRegistry?.getClass(className);
          if (isKnownClass) {
            const syntheticType = new ClassTypeSymbol(
              className,
              UdonType.Int32,
            );
            return resolveMethodReturnType(
              converter,
              syntheticType,
              pa.property,
            );
          }
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Resolve the return type of a method on a given base type.
 * For inline class return types (not known extern types), creates a
 * ClassTypeSymbol so callers can identify the concrete class.
 */
function resolveMethodReturnType(
  converter: ASTToTACConverter,
  baseType: TypeSymbol,
  methodName: string,
): TypeSymbol | null {
  const typeName = baseType.name;
  if (!typeName) return null;

  const resolveReturnTypeStr = (retType: string): TypeSymbol => {
    const mapped = converter.typeMapper.mapTypeScriptType(retType);
    // If the mapper returned ObjectType but the name is a known inline class,
    // create a ClassTypeSymbol so callers can identify the concrete type.
    if (
      mapped === ObjectType &&
      retType !== "object" &&
      retType !== "unknown" &&
      retType !== "any"
    ) {
      const isInlineClass =
        converter.classMap.has(retType) ||
        (converter.classRegistry?.getClass(retType) &&
          !converter.udonBehaviourClasses.has(retType));
      if (isInlineClass) {
        return new ClassTypeSymbol(retType, UdonType.Int32);
      }
    }
    return mapped;
  };

  // Check class registry for inline classes
  if (converter.classRegistry) {
    const classMeta = converter.classRegistry.getClass(typeName);
    if (classMeta) {
      const method = converter.classRegistry
        .getMergedMethods(typeName)
        .find((m) => m.name === methodName);
      if (method) {
        return resolveReturnTypeStr(method.returnType);
      }
    }
    const ifaceMeta = converter.classRegistry.getInterface(typeName);
    if (ifaceMeta) {
      const method = ifaceMeta.methods.find((m) => m.name === methodName);
      if (method) {
        return resolveReturnTypeStr(method.returnType);
      }
    }
  }
  // Check class map (AST nodes) — walk inheritance chain via resolveClassMethod
  // to handle methods defined on base classes. Pipe through resolveReturnTypeStr
  // when the return type name is available so inline class return types get
  // upgraded from ObjectType to ClassTypeSymbol (consistent with classRegistry paths).
  const resolved = resolveClassMethod(converter, typeName, methodName);
  if (resolved) {
    const rt = resolved.method.returnType;
    if (rt.name) return resolveReturnTypeStr(rt.name);
    return rt;
  }
  return null;
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
    case ASTNodeKind.FunctionExpression:
      throw new Error(
        "Function expressions are only supported as Set.forEach callbacks.",
      );
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
    const leftOriginal = this.visitExpression(node.left);
    const rightOriginal = this.visitExpression(node.right);
    const baseOp = compoundOps[node.operator];
    // compoundOps does not contain <<= or >>=, so no shift guard needed.
    // C# compound assignment: x op= y ≡ x = (T)(x op y), where T = typeof(x).
    const isBitwiseCompound =
      baseOp === "&" || baseOp === "|" || baseOp === "^";
    const w = isBitwiseCompound
      ? narrowToInt32ForBitwise(this, leftOriginal, rightOriginal)
      : widenNumericOperands(this, leftOriginal, rightOriginal);
    const opResult = this.newTemp(this.getOperandType(w.left));
    this.instructions.push(
      new BinaryOpInstruction(opResult, w.left, baseOp, w.right),
    );

    let assignValue: TACOperand = opResult;
    // Narrow back to the original left operand's type if promotion widened it.
    if (w.left !== leftOriginal) {
      const narrowed = this.newTemp(this.getOperandType(leftOriginal));
      this.instructions.push(new CastInstruction(narrowed, opResult));
      assignValue = narrowed;
    }

    if (leftOriginal.kind === TACOperandKind.Variable) {
      const target = leftOriginal as VariableOperand;
      this.emitCopyWithTracking(target, assignValue);
      return assignValue;
    }

    return this.assignToTarget(node.left, assignValue);
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
  // Only run the chain flattener when useStringBuilder is true;
  // otherwise the pairwise string-concat fallback below handles it.
  if (node.operator === "+" && this.useStringBuilder) {
    const chain = flattenStringConcatChain(this, node);
    if (chain) {
      const partsOperands: TACOperand[] = [];
      for (const partNode of chain) {
        let partOperand: TACOperand;
        if (
          partNode.kind === ASTNodeKind.Literal &&
          (partNode as LiteralNode).type.udonType === UdonType.String
        ) {
          const lit = partNode as LiteralNode;
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
              new MethodCallInstruction(
                partOperand,
                exprResult,
                "ToString",
                [],
              ),
            );
          }
        }
        partsOperands.push(partOperand);
      }
      if (partsOperands.length === 0) {
        return createConstant("", PrimitiveTypes.string);
      }
      if (partsOperands.length >= this.stringBuilderThreshold) {
        return generateStringBuilderConcat(this, partsOperands);
      }
      // Below threshold: build a String.Concat chain directly to avoid re-visiting
      let resultOperand: TACOperand = partsOperands[0];
      for (let i = 1; i < partsOperands.length; i += 1) {
        const partOperand = partsOperands[i];
        const newResult = this.newTemp(PrimitiveTypes.string);
        const concatExtern = this.requireExternSignature(
          "System.String",
          "Concat",
          "method",
          ["string", "string"],
          "System.String",
        );
        this.instructions.push(
          new CallInstruction(newResult, concatExtern, [
            resultOperand,
            partOperand,
          ]),
        );
        resultOperand = newResult;
      }
      return resultOperand;
    }
  }
  // flattenStringConcatChain uses resolveTypeFromNode (read-only type
  // inspection) and never calls visitExpression, so visiting left/right
  // here does not double-evaluate any sub-expression.
  let left = this.visitExpression(node.left);
  let right = this.visitExpression(node.right);

  // Determine result type - comparison operators return Boolean
  const isComparison = ["<", ">", "<=", ">=", "==", "!="].includes(
    node.operator,
  );
  // String concatenation with mixed types: call ToString on non-string operand.
  // Entry conditions:
  //   (a) useStringBuilder is false → chain detection skipped entirely; all
  //       string + non-string binary exprs are handled here.
  //   (b) useStringBuilder is true AND flattenStringConcatChain returned null
  //       (e.g., left sub-expr like `(intA + intB)` has no string-typed leaf).
  // Note: leftType/rightType are only used inside this block (which returns early).
  {
    const leftType = this.getOperandType(left);
    const rightType = this.getOperandType(right);
    if (
      node.operator === "+" &&
      (leftType.udonType === UdonType.String ||
        rightType.udonType === UdonType.String)
    ) {
      if (leftType.udonType !== UdonType.String) {
        const strLeft = this.newTemp(PrimitiveTypes.string);
        this.instructions.push(
          new MethodCallInstruction(strLeft, left, "ToString", []),
        );
        left = strLeft;
      }
      if (rightType.udonType !== UdonType.String) {
        const strRight = this.newTemp(PrimitiveTypes.string);
        this.instructions.push(
          new MethodCallInstruction(strRight, right, "ToString", []),
        );
        right = strRight;
      }
      const concatExtern = this.requireExternSignature(
        "System.String",
        "Concat",
        "method",
        ["string", "string"],
        "System.String",
      );
      const result = this.newTemp(PrimitiveTypes.string);
      this.instructions.push(
        new CallInstruction(result, concatExtern, [left, right]),
      );
      return result;
    }
  }

  const isBitwise =
    node.operator === "|" || node.operator === "&" || node.operator === "^";
  const isShift = node.operator === "<<" || node.operator === ">>";

  if (isBitwise) {
    // Narrow to Int32 for bitwise ops — Udon VM has no float bitwise EXTERNs.
    const n = narrowToInt32ForBitwise(this, left, right);
    left = n.left;
    right = n.right;
  } else if (!isShift) {
    // Widen narrower operand when both are numeric and types differ (skip shifts).
    const w = widenNumericOperands(this, left, right);
    left = w.left;
    right = w.right;
  }

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
  this.emitCopyWithTracking(result, right);
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
  this.emitCopyWithTracking(result, right);
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
  // Plain copy: the shared result temp is written from two diverging
  // branches — tracking would retain only the last-written branch's
  // prefix, producing incorrect property resolution for the other branch.
  this.instructions.push(new CopyInstruction(result, trueVal));
  this.instructions.push(new UnconditionalJumpInstruction(endLabel));

  this.instructions.push(new LabelInstruction(falseLabel));
  const falseVal = this.visitExpression(node.whenFalse);
  // Upgrade result type if the false branch provides a more specific
  // non-primitive reference type. Only upgrade for types that benefit from
  // inline dispatch (ArrayTypeSymbol, InterfaceTypeSymbol, CollectionTypeSymbol).
  // Primitive types (int, float, bool, string) must not override ObjectType
  // because the true branch may hold an incompatible boxed value.
  if (result.kind === TACOperandKind.Temporary) {
    const falseType = this.getOperandType(falseVal);
    if (
      (result as TemporaryOperand).type === ObjectType &&
      falseType !== ObjectType &&
      (falseType instanceof ArrayTypeSymbol ||
        falseType instanceof InterfaceTypeSymbol ||
        falseType instanceof CollectionTypeSymbol ||
        falseType instanceof DataListTypeSymbol)
    ) {
      (result as TemporaryOperand).type = falseType;
    }
  }
  this.instructions.push(new CopyInstruction(result, falseVal)); // Plain copy: see true-branch comment above.
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
  // Upgrade result type if the right operand provides a more specific
  // non-primitive reference type. Same guard as visitConditionalExpression.
  if (result.kind === TACOperandKind.Temporary) {
    const rightType = this.getOperandType(right);
    if (
      (result as TemporaryOperand).type === ObjectType &&
      rightType !== ObjectType &&
      (rightType instanceof ArrayTypeSymbol ||
        rightType instanceof InterfaceTypeSymbol ||
        rightType instanceof CollectionTypeSymbol ||
        rightType instanceof DataListTypeSymbol)
    ) {
      (result as TemporaryOperand).type = rightType;
    }
  }
  // Plain copy: same shared-result reasoning as visitConditionalExpression.
  this.instructions.push(new CopyInstruction(result, right));
  this.instructions.push(new UnconditionalJumpInstruction(endLabel));

  this.instructions.push(new LabelInstruction(notNullLabel));
  this.instructions.push(new CopyInstruction(result, left)); // Plain copy: see null-path comment above.
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

function resolveSpreadArrayType(
  converter: ASTToTACConverter,
  node: ASTNode,
): ArrayTypeSymbol | null {
  let resolved = resolveTypeFromNode(converter, node);
  if (!resolved && node.kind === ASTNodeKind.PropertyAccessExpression) {
    const access = node as PropertyAccessExpressionNode;
    if (access.object.kind === ASTNodeKind.Identifier) {
      const ident = access.object as IdentifierNode;
      const sym = converter.symbolTable.lookup(ident.name);
      if (sym?.type) {
        resolved = resolvePropertyTypeFromType(
          converter,
          sym.type,
          access.property,
        );
      }
    }
    if (
      !resolved &&
      access.object.kind === ASTNodeKind.ThisExpression &&
      converter.currentClassName
    ) {
      const classNode = converter.classMap.get(converter.currentClassName);
      const prop = classNode?.properties.find(
        (p) => p.name === access.property,
      );
      if (prop) resolved = prop.type;
    }
  }
  return resolved instanceof ArrayTypeSymbol ? resolved : null;
}

export function visitArrayLiteralExpression(
  this: ASTToTACConverter,
  node: ArrayLiteralExpressionNode,
): TACOperand {
  // Typed array spread concat optimization:
  // [...arr1, ...arr2] where all sources are typed arrays → arr1.concat(arr2)
  if (
    node.elements.length >= 2 &&
    node.elements.every((e) => e.kind === "spread")
  ) {
    const resolvedTypes: ArrayTypeSymbol[] = [];
    let allTypedArrays = true;
    for (const elem of node.elements) {
      const resolved = resolveSpreadArrayType(this, elem.value);
      if (resolved) {
        resolvedTypes.push(resolved);
      } else {
        allTypedArrays = false;
        break;
      }
    }

    if (allTypedArrays) {
      let baseType = resolvedTypes[0];
      if (node.typeHint) {
        const contextType = this.typeMapper.mapTypeScriptType(node.typeHint);
        if (contextType instanceof ArrayTypeSymbol) {
          baseType = contextType;
        }
      }
      const allCompatible = resolvedTypes.every((t) =>
        t.isAssignableTo(baseType),
      );
      if (allCompatible) {
        const operands = node.elements.map((e) =>
          this.visitExpression(e.value),
        );
        // Udon VM does not have a native Array.concat extern.
        // Implement concat as: allocate new array, copy elements from each.
        let result = operands[0];
        for (let i = 1; i < operands.length; i++) {
          result = emitArrayConcat(this, result, operands[i]);
        }
        return result;
      }
    }
  }

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
        let resolvedType = resolveTypeFromNode(this, element.value);
        // Additional fallback: if resolveTypeFromNode couldn't determine the
        // property type for a PropertyAccessExpression, try looking up the
        // base identifier in the current symbol table or the current class
        // properties. This helps in cases like `ponMeld.tiles` where the
        // identifier has a declared type but the node-level resolver missed it.
        if (
          !resolvedType &&
          element.value.kind === ASTNodeKind.PropertyAccessExpression
        ) {
          const access = element.value as PropertyAccessExpressionNode;
          // If base is an identifier, try symbol table
          if (access.object.kind === ASTNodeKind.Identifier) {
            const ident = access.object as IdentifierNode;
            const sym = this.symbolTable.lookup(ident.name);
            if (sym?.type) {
              resolvedType = resolvePropertyTypeFromType(
                this,
                sym.type,
                access.property,
              );
            }
            // If the symbol was created with an initializer AST, try resolving
            // the property type from that initializer as a fallback.
            if (!resolvedType && sym?.initialValue) {
              const initResolved = resolveTypeFromNode(
                this,
                sym.initialValue as ASTNode,
              );
              if (initResolved) {
                resolvedType = resolvePropertyTypeFromType(
                  this,
                  initResolved,
                  access.property,
                );
              }
            }
          }
          // If base is `this`, try current class declaration
          if (
            !resolvedType &&
            access.object.kind === ASTNodeKind.ThisExpression &&
            this.currentClassName
          ) {
            const classNode = this.classMap.get(this.currentClassName);
            const prop = classNode?.properties.find(
              (p) => p.name === access.property,
            );
            if (prop) resolvedType = prop.type;
          }
        }
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
        const describeNode = (n: ASTNode, depth = 0): string => {
          if (depth > 50) return "...";
          switch (n.kind) {
            case ASTNodeKind.Identifier:
              return (n as IdentifierNode).name;
            case ASTNodeKind.PropertyAccessExpression: {
              const p = n as PropertyAccessExpressionNode;
              return `${describeNode(p.object, depth + 1)}.${p.property}`;
            }
            case ASTNodeKind.ArrayAccessExpression: {
              const a = n as ArrayAccessExpressionNode;
              return `${describeNode(a.array, depth + 1)}[${describeNode(
                a.index,
                depth + 1,
              )}]`;
            }
            case ASTNodeKind.CallExpression: {
              const c = n as CallExpressionNode;
              return `${describeNode(c.callee, depth + 1)}(...)`;
            }
            case ASTNodeKind.BinaryExpression: {
              const b = n as BinaryExpressionNode;
              return `${describeNode(b.left, depth + 1)} ${b.operator} ${describeNode(
                b.right,
                depth + 1,
              )}`;
            }
            case ASTNodeKind.UnaryExpression: {
              const u = n as UnaryExpressionNode;
              return `${u.operator}${describeNode(u.operand, depth + 1)}`;
            }
            case ASTNodeKind.Literal: {
              const lit = n as LiteralNode;
              return String(lit.value);
            }
            default:
              return String(n.kind);
          }
        };

        const buildSymbolDiag = (
          identName: string,
          s: SymbolInfo | undefined,
        ): string => {
          if (!s) return "";
          const tname = s.type?.name ?? "<unknown>";
          const inits = s.initialValue
            ? describeNode(s.initialValue as ASTNode)
            : "<none>";
          return `; symbol(${identName})={type:${tname},initial:${inits}}`;
        };

        const sourceHint = describeNode(element.value);
        const spreadTypeName = spreadType ? `${spreadType.name}` : "<unknown>";
        const spreadUdon = spreadType ? `${spreadType.udonType}` : "<unknown>";

        // Diagnostic details: if the spread expression is a property access,
        // include info about the base expression resolution and any symbol info
        let diag = "";
        if (element.value.kind === ASTNodeKind.PropertyAccessExpression) {
          const access = element.value as PropertyAccessExpressionNode;
          const baseDesc = describeNode(access.object);
          const baseResolved = resolveTypeFromNode(this, access.object);
          const baseResolvedName = baseResolved
            ? baseResolved.name
            : "<unknown>";
          diag += `; base=${baseDesc} -> ${baseResolvedName}`;
          if (access.object.kind === ASTNodeKind.Identifier) {
            const ident = access.object as IdentifierNode;
            diag += buildSymbolDiag(
              ident.name,
              this.symbolTable.lookup(ident.name),
            );
          }
        } else if (element.value.kind === ASTNodeKind.Identifier) {
          const ident = element.value as IdentifierNode;
          diag += buildSymbolDiag(
            ident.name,
            this.symbolTable.lookup(ident.name),
          );
        }

        throw new Error(
          `Array spread expects an Array or DataList (spread expression "${sourceHint}" resolved to ${spreadTypeName} (${spreadUdon})${diag})`,
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
      // All arrays (both DataList and ArrayTypeSymbol) use Count at runtime.
      this.instructions.push(
        new PropertyGetInstruction(lengthVar, spreadValue, "Count"),
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

      // All arrays use DataList.get_Item at runtime → returns DataToken.
      const itemToken = this.newTemp(ExternTypes.dataToken);
      this.instructions.push(
        new MethodCallInstruction(itemToken, spreadValue, "get_Item", [
          indexVar,
        ]),
      );
      // DataList.Add expects DataToken — pass directly, no wrap/unwrap needed.
      const token = itemToken;
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
      this.udonBehaviourClasses.has(node.name) ||
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
    if (this.classRegistry) {
      const meta = this.classRegistry.getClass(node.name);
      if (meta && !this.classRegistry.isStub(node.name)) {
        this.classMap.set(node.name, meta.node);
        return createVariable(node.name, ObjectType);
      }
    }
    const location = this.currentClassName
      ? `${this.currentClassName}${this.currentMethodName ? `.${this.currentMethodName}` : ""}`
      : "<unknown>";
    throw new Error(`Undefined variable: ${node.name} in ${location}`);
  }

  // Inline top-level literal constants using the declared type
  if (
    symbol.isConstant &&
    (symbol.scope ?? 0) === 0 &&
    symbol.initialValue &&
    (symbol.initialValue as ASTNode).kind === ASTNodeKind.Literal
  ) {
    const literal = symbol.initialValue as LiteralNode;
    return createConstant(literal.value, symbol.type);
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
    // Coerce index to Int32 for DataList.get_Item (expects SystemInt32)
    let coercedIndex = index;
    const indexType = this.getOperandType(index);
    if (needsInt32IndexCoercion(indexType.udonType)) {
      const intIndex = this.newTemp(PrimitiveTypes.int32);
      this.instructions.push(new CastInstruction(intIndex, index));
      coercedIndex = intIndex;
    }
    const elementType =
      arrayType instanceof DataListTypeSymbol
        ? arrayType.elementType
        : ObjectType;
    const tokenResult = this.newTemp(ExternTypes.dataToken);
    this.instructions.push(
      new MethodCallInstruction(tokenResult, array, "get_Item", [coercedIndex]),
    );
    if (arrayType instanceof DataListTypeSymbol) {
      return this.unwrapDataToken(tokenResult, elementType);
    }
    return tokenResult;
  }

  // Current lowering policy routes ArrayTypeSymbol through DataList semantics:
  // get_Item + DataToken unwrap instead of typed native array Get/Set.
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
  const resolvedElementType = elementType ?? ObjectType;
  // Coerce index to Int32 for DataList.get_Item
  let coercedIndex = index;
  const idxType = this.getOperandType(index);
  if (needsInt32IndexCoercion(idxType.udonType)) {
    const intIndex = this.newTemp(PrimitiveTypes.int32);
    this.instructions.push(new CastInstruction(intIndex, index));
    coercedIndex = intIndex;
  }
  const tokenResult = this.newTemp(ExternTypes.dataToken);
  this.instructions.push(
    new MethodCallInstruction(tokenResult, array, "get_Item", [coercedIndex]),
  );
  return this.unwrapDataToken(tokenResult, resolvedElementType);
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
      this.currentInlineContext &&
      !this.currentThisOverride
    ) {
      const mapped = this.mapInlineProperty(
        this.currentInlineContext.className,
        this.currentInlineContext.instancePrefix,
        node.property,
      );
      if (mapped) return mapped;
    }

    // Entry point class self-property READ: direct variable reference
    if (
      node.object.kind === ASTNodeKind.ThisExpression &&
      this.currentClassName &&
      this.entryPointClasses.has(this.currentClassName) &&
      !this.currentInlineContext &&
      !this.currentThisOverride
    ) {
      const resolved = resolveClassProperty(
        this,
        this.currentClassName,
        node.property,
      );
      if (resolved) {
        return createVariable(
          this.entryPointPropName(node.property),
          resolved.prop.type,
        );
      }
    }

    if (node.object.kind === ASTNodeKind.Identifier) {
      const instanceInfo = this.resolveInlineInstance(
        (node.object as IdentifierNode).name,
      );
      if (instanceInfo) {
        const mapped = tryMapInlinePropertyWithConcreteFallback(
          this,
          instanceInfo,
          node.property,
        );
        if (mapped) return mapped;
      }
    }

    // Static property access on inline classes: ClassName.staticField
    if (node.object.kind === ASTNodeKind.Identifier) {
      const objectName = (node.object as IdentifierNode).name;
      if (
        !this.symbolTable.lookup(objectName) && // not shadowed by a local
        resolveClassNode(this, objectName) &&
        !this.udonBehaviourClasses.has(objectName)
      ) {
        const mapped = this.mapStaticProperty(objectName, node.property);
        if (mapped) {
          return mapped;
        }
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
        const returnType = resolveExternReturnType(externSig) ?? ObjectType;
        const result = this.newTemp(returnType);
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

    // Post-evaluation inline instance resolution for chained access.
    // Inside inlined methods this is typically a direct hit since
    // currentParamExportMap is empty; in caller context the helper
    // bridges raw ↔ export names via currentParamExportMap.
    // operandTrackingKey handles both Variable and Temporary operands.
    const instanceKey = operandTrackingKey(object);
    const instanceInfo = instanceKey
      ? this.resolveInlineInstance(instanceKey)
      : undefined;

    if (instanceInfo) {
      const mapped = tryMapInlinePropertyWithConcreteFallback(
        this,
        instanceInfo,
        node.property,
      );
      if (mapped) return mapped;

      // Interface classId-based property dispatch: when the interface-level
      // mapInlineProperty fails (e.g. property not in interface metadata),
      // fall back to dispatching by classId to each concrete implementor.
      const classIds = this.interfaceClassIdMap.get(instanceInfo.className);
      if (
        classIds &&
        classIds.size > 0 &&
        isAllInlineInterface(this, instanceInfo.className)
      ) {
        let propType: TypeSymbol | undefined;
        for (const [className] of classIds) {
          const resolved = resolveClassProperty(this, className, node.property);
          if (resolved) {
            propType = resolved.prop.type;
            break;
          }
        }
        if (propType) {
          const result = createVariable(
            `__iface_prop_${this.tempCounter++}`,
            propType,
            { isLocal: true },
          );
          const endLabel = this.newLabel("iface_prop_end");
          const classIdVar = createVariable(
            `${instanceInfo.prefix}__classId`,
            PrimitiveTypes.int32,
          );

          for (const [className, classId] of classIds) {
            const nextLabel = this.newLabel("iface_prop_next");
            const cond = this.newTemp(PrimitiveTypes.boolean);
            this.instructions.push(
              new BinaryOpInstruction(
                cond,
                classIdVar,
                "==",
                createConstant(classId, PrimitiveTypes.int32),
              ),
            );
            this.instructions.push(
              new ConditionalJumpInstruction(cond, nextLabel),
            );

            const concreteMapped = this.mapInlineProperty(
              className,
              instanceInfo.prefix,
              node.property,
            );
            if (!concreteMapped) {
              throw new Error(
                `Internal error: mapInlineProperty returned undefined for property '${node.property}' on class '${className}', but resolveClassProperty succeeded. This indicates an inconsistency in class registration.`,
              );
            }
            this.emitCopyWithTracking(result, concreteMapped);

            this.instructions.push(new UnconditionalJumpInstruction(endLabel));
            this.instructions.push(new LabelInstruction(nextLabel));
          }
          this.instructions.push(new LabelInstruction(endLabel));
          return result;
        }
      }
    }

    // Handle-based dispatch for variables/temporaries of known concrete inline
    // types. Fires when the tracked path above did not return a result — either
    // because the operand has no tracking entry, or because both
    // tryMapInlinePropertyWithConcreteFallback and the classId dispatch failed.
    // This acts as the final fallback before a raw PropertyGetInstruction.
    // Limited to ≤100 instances per class to avoid excessive code.
    // Covers both Variable and Temporary operands (e.g. tiles[i].code).
    if (
      object.kind === TACOperandKind.Variable ||
      object.kind === TACOperandKind.Temporary
    ) {
      const untrackedType = this.getOperandType(object);
      const untrackedTypeName = untrackedType.name;
      if (
        untrackedTypeName &&
        !this.udonBehaviourClasses.has(untrackedTypeName)
      ) {
        const dispInstances: Array<
          [number, { prefix: string; className: string }]
        > = [];
        // Also match concrete implementors when untrackedTypeName is an
        // interface name (e.g. IYaku). classRegistry is authoritative because
        // it is built from class declarations before codegen starts.
        // Cache per-type to avoid repeated O(N) lookups across property accesses
        // on the same untracked interface-typed variable.
        if (!this.implementorNamesCache.has(untrackedTypeName)) {
          this.implementorNamesCache.set(
            untrackedTypeName,
            this.classRegistry
              ? new Set(
                  this.classRegistry
                    .getImplementorsOfInterface(untrackedTypeName)
                    .map((i) => i.name),
                )
              : null,
          );
        }
        const implementorNames =
          this.implementorNamesCache.get(untrackedTypeName) ?? null;
        for (const [instId, info] of this.allInlineInstances) {
          if (
            info.className === untrackedTypeName ||
            implementorNames?.has(info.className)
          ) {
            dispInstances.push([instId, info]);
          }
        }
        // Track whether dispInstances were populated by a fallback heuristic
        // (AST type or property-based). When true, a miss path must emit a
        // PropertyGetInstruction instead of returning a zeroed heap default,
        // because the runtime value may not be an inline handle at all.
        let usedErasedFallback = false;
        // AST type fallback: when operand type is erased (ObjectType,
        // CollectionTypeSymbol, etc.) and no instances matched, try resolving
        // the base type from the AST and retry with that name.
        if (dispInstances.length === 0) {
          const astBaseType = resolveTypeFromNode(this, node.object);
          const astTypeName = astBaseType?.name;
          if (astTypeName && astTypeName !== untrackedTypeName) {
            if (!this.implementorNamesCache.has(astTypeName)) {
              this.implementorNamesCache.set(
                astTypeName,
                this.classRegistry
                  ? new Set(
                      this.classRegistry
                        .getImplementorsOfInterface(astTypeName)
                        .map((i) => i.name),
                    )
                  : null,
              );
            }
            const astImplementorNames =
              this.implementorNamesCache.get(astTypeName) ?? null;
            for (const [instId, info] of this.allInlineInstances) {
              if (
                info.className === astTypeName ||
                astImplementorNames?.has(info.className)
              ) {
                dispInstances.push([instId, info]);
              }
            }
            if (dispInstances.length > 0) usedErasedFallback = true;
          }
        }
        // Property-based fallback: when the operand type is erased and no
        // instances matched by type name, scan inline instances for classes
        // that expose the accessed property. Fires for both ObjectType
        // (name "object") and ExternTypes.dataDictionary (name "DataDictionary",
        // because TypeMapper maps TS "object" to dataDictionary).
        if (
          dispInstances.length === 0 &&
          (untrackedTypeName === "object" ||
            untrackedTypeName === "DataDictionary")
        ) {
          const candidateClasses = new Set<string>();
          for (const [, info] of this.allInlineInstances) {
            if (candidateClasses.has(info.className)) continue;
            // Use resolveClassProperty (class-definition lookup) instead of
            // mapInlineProperty (heap-variable lookup) so the check does not
            // depend on a specific instance's prefix.
            if (resolveClassProperty(this, info.className, node.property)) {
              candidateClasses.add(info.className);
            }
          }
          if (candidateClasses.size === 1) {
            // Exactly one class matches — use it directly.
            for (const [instId, info] of this.allInlineInstances) {
              if (candidateClasses.has(info.className)) {
                dispInstances.push([instId, info]);
              }
            }
            if (dispInstances.length > 0) usedErasedFallback = true;
          } else if (candidateClasses.size > 1) {
            // Multiple classes share this property name. Try to narrow using
            // the AST type of the object node (e.g. the declared element type
            // of a for-of loop variable, or an interface implementor).
            const astType = resolveTypeFromNode(this, node.object);
            const astName = astType?.name;
            let narrowedClass: string | undefined;
            if (astName) {
              if (candidateClasses.has(astName)) {
                narrowedClass = astName;
              } else {
                // AST type may be an interface — check implementors
                const implNames = this.classRegistry
                  ? this.classRegistry
                      .getImplementorsOfInterface(astName)
                      .map((i) => i.name)
                  : [];
                for (const impl of implNames) {
                  if (candidateClasses.has(impl)) {
                    narrowedClass = impl;
                    break;
                  }
                }
              }
            }
            if (narrowedClass) {
              for (const [instId, info] of this.allInlineInstances) {
                if (info.className === narrowedClass) {
                  dispInstances.push([instId, info]);
                }
              }
              if (dispInstances.length > 0) usedErasedFallback = true;
            } else {
              // Narrowing failed — force safe path. Pick the first
              // candidate (by allInlineInstances insertion order) to
              // produce a dispatch table rather than falling through
              // to a raw PropertyGetInstruction that would generate an
              // invalid EXTERN. Instances of other candidate classes
              // will hit the miss path and receive the zero-init default.
              const firstCandidate = candidateClasses.values().next()
                .value as string;
              // WARNING: mixed-class collections with this property will
              // silently return zero-init defaults for non-first-candidate
              // instances. Log at transpile time to aid debugging.
              console.warn(
                `transpiler: D3 dispatch narrowing failed for property "${node.property}" — ` +
                  `${candidateClasses.size} candidate classes (${[...candidateClasses].join(", ")}), ` +
                  `using "${firstCandidate}" only.`,
              );
              for (const [instId, info] of this.allInlineInstances) {
                if (info.className === firstCandidate) {
                  dispInstances.push([instId, info]);
                }
              }
              if (dispInstances.length > 0) usedErasedFallback = true;
            }
          }
        }
        if (dispInstances.length > 0 && dispInstances.length <= 100) {
          let untrackedPropType: TypeSymbol | undefined;
          for (const [, info] of dispInstances) {
            const pv = this.mapInlineProperty(
              info.className,
              info.prefix,
              node.property,
            );
            if (pv) {
              untrackedPropType = pv.type;
              break;
            }
          }
          if (untrackedPropType) {
            // Use the concrete inline field type for the dispatch result.
            // The miss path no longer emits a PropertyGetInstruction (it
            // uses Debug.LogError instead), so there is no need to widen
            // to ObjectType for heap-slot compatibility.
            const dispResult = createVariable(
              `__uninst_prop_${this.tempCounter++}`,
              untrackedPropType,
              { isLocal: true },
            );
            const hdlVar = this.newTemp(PrimitiveTypes.int32);
            this.instructions.push(new CopyInstruction(hdlVar, object));
            const dispEnd = this.newLabel("uninst_prop_end");
            for (const [instId, info] of dispInstances) {
              const dispNext = this.newLabel("uninst_prop_next");
              const dispCond = this.newTemp(PrimitiveTypes.boolean);
              this.instructions.push(
                new BinaryOpInstruction(
                  dispCond,
                  hdlVar,
                  "==",
                  createConstant(instId, PrimitiveTypes.int32),
                ),
              );
              this.instructions.push(
                // Jump to dispNext when handle does NOT match (JUMP_IF_FALSE semantics)
                new ConditionalJumpInstruction(dispCond, dispNext),
              );
              const pv = this.mapInlineProperty(
                info.className,
                info.prefix,
                node.property,
              );
              if (pv) {
                this.emitCopyWithTracking(dispResult, pv);
              }
              // If pv is undefined here it means mapInlineProperty failed for
              // this instance. This should not happen: all entries in
              // dispInstances share the same className (enforced by the filter
              // above), so every instance must expose the same property set.
              this.instructions.push(new UnconditionalJumpInstruction(dispEnd));
              this.instructions.push(new LabelInstruction(dispNext));
            }
            // Miss path: if no handle matched in the dispatch table.
            if (usedErasedFallback) {
              // Do NOT emit PropertyGetInstruction here. The erased owner
              // type produces invalid EXTERN signatures (e.g.
              // DataDictionary.__get_isOpen__SystemObject) that the Udon VM
              // rejects at load time. The miss path is unreachable when all
              // instances of the target class are tracked via
              // allInlineInstances. Emit a diagnostic log so that reaching
              // this path at runtime (which would indicate a transpiler bug)
              // is visible in the VRChat console.
              const logExtern = this.requireExternSignature(
                "Debug",
                "LogError",
                "method",
                ["object"],
                "void",
              );
              const errMsg = createConstant(
                `[udon-assembly-ts] D3 dispatch miss: ${node.property} on untracked instance`,
                PrimitiveTypes.string,
              );
              this.instructions.push(
                new CallInstruction(undefined, logExtern, [errMsg]),
              );
              // dispResult retains its Udon heap zero-initialised default
              // (null for references, 0 for int32, false for bool).
              // No explicit COPY needed — emitting one with a null literal
              // would risk a type mismatch for value types.
            }
            // For non-erased D3 dispatch the miss is unreachable: every object
            // of the matched type was constructed via a tracked constructor,
            // so its runtime handle always matches one branch above.
            this.instructions.push(new LabelInstruction(dispEnd));
            return dispResult;
          }
        }
      }
    }

    const objectType = this.getOperandType(object);

    // Early return for .length on arrays — always int32.
    // Arrays are backed by DataList, so use "Count" property.
    if (objectType instanceof ArrayTypeSymbol && node.property === "length") {
      const result = this.newTemp(PrimitiveTypes.int32);
      this.instructions.push(
        new PropertyGetInstruction(result, object, "Count"),
      );
      return result;
    }

    // DataList .length → .Count mapping with int32 return type.
    if (
      (objectType instanceof DataListTypeSymbol ||
        objectType.name === ExternTypes.dataList.name ||
        objectType.udonType === UdonType.DataList) &&
      node.property === "length"
    ) {
      const result = this.newTemp(PrimitiveTypes.int32);
      this.instructions.push(
        new PropertyGetInstruction(result, object, "Count"),
      );
      return result;
    }

    // Iterator result .value on DataToken: unwrap via .Reference property.
    // Handles the tail of the `map.keys().next().value` pattern.
    // Note: .Reference returns null for primitive-keyed maps (int, float);
    // only string/reference-type keys are supported by this pattern.
    if (
      objectType.name === ExternTypes.dataToken.name &&
      node.property === "value"
    ) {
      const result = this.newTemp(ObjectType);
      this.instructions.push(
        new PropertyGetInstruction(result, object, "Reference"),
      );
      return result;
    }

    const resolvedBaseType = resolveTypeFromNode(this, node.object);
    const isSet =
      isSetCollectionType(objectType) || isSetCollectionType(resolvedBaseType);
    const isMap =
      isMapCollectionType(objectType) || isMapCollectionType(resolvedBaseType);
    if ((isSet || isMap) && node.property === "size") {
      const result = this.newTemp(PrimitiveTypes.int32);
      this.instructions.push(
        new PropertyGetInstruction(result, object, "Count"),
      );
      return result;
    }
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
    const result = this.newTemp(resultType ?? ObjectType);

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
  if (this.currentThisOverride) {
    return this.currentThisOverride;
  }
  if (this.currentInlineContext) {
    const { instancePrefix } = this.currentInlineContext;
    return createVariable(`${instancePrefix}__handle`, ObjectType);
  }
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
  const expected = this.currentExpectedType;
  if (
    expected instanceof InterfaceTypeSymbol &&
    expected.properties.size > 0 &&
    !node.properties.some((p) => p.kind === "spread")
  ) {
    const className = expected.name;
    // Register the InterfaceTypeSymbol so mapInlineProperty can resolve properties
    if (!this.typeMapper.getAlias(className)) {
      this.typeMapper.registerTypeAlias(className, expected);
    }
    // Deduplicate object literal instances across repeated method body inlinings.
    // When inside an inlined method body, reuse the same prefix/instanceId for
    // the Nth object literal in that body across all inlinings of the same body.
    const { instancePrefix, instanceId } =
      this.allocateBodyCachedInstance(className);
    // Use Int32 handle (same as visitInlineConstructor) so allInlineInstances
    // dispatch can match by instanceId at runtime.
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
    for (const prop of node.properties) {
      if (prop.kind !== "property") continue;
      const rawPropType = expected.properties.get(prop.key);
      // Re-resolve through typeMapper in case the property type was registered
      // before its type alias (e.g. Wind) was defined (parse-order issue).
      const propType = rawPropType?.name
        ? (this.typeMapper.getAlias(rawPropType.name) ?? rawPropType)
        : rawPropType;
      const propVar = createVariable(
        `${instancePrefix}_${prop.key}`,
        propType ?? ObjectType,
      );
      // Propagate expected type for nested typed object literals
      const prev = this.currentExpectedType;
      if (
        propType instanceof InterfaceTypeSymbol &&
        prop.value.kind === ASTNodeKind.ObjectLiteralExpression
      ) {
        this.currentExpectedType = propType;
      } else {
        this.currentExpectedType = undefined;
      }
      const value = this.visitExpression(prop.value);
      this.currentExpectedType = prev;
      this.instructions.push(new AssignmentInstruction(propVar, value));
      this.maybeTrackInlineInstanceAssignment(propVar, value);
    }
    return instanceHandle;
  }
  return this.emitDictionaryFromProperties(node.properties);
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
    // delete arr[i] → set_Item(i, DataToken(null))
    const nullValue = createConstant(null, ObjectType);
    let coercedIndex = index;
    const idxType = this.getOperandType(index);
    if (needsInt32IndexCoercion(idxType.udonType)) {
      const intIndex = this.newTemp(PrimitiveTypes.int32);
      this.instructions.push(new CastInstruction(intIndex, index));
      coercedIndex = intIndex;
    }
    const token = this.wrapDataToken(nullValue);
    this.instructions.push(
      new MethodCallInstruction(undefined, array, "set_Item", [
        coercedIndex,
        token,
      ]),
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
  this.emitCopyWithTracking(objTemp, obj);

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
  // Create a named variable to hold objTemp so visitPropertyAccessExpression
  // can look it up by name and get proper inline tracking. Use a temporary
  // scope to avoid leaking the symbol into the enclosing scope.
  const optBaseType = this.getOperandType(objTemp);
  const optBaseName = `__opt_base_${this.tempCounter++}`;
  const optBase = createVariable(optBaseName, optBaseType, { isLocal: true });
  this.symbolTable.enterScope();
  let propResult: TACOperand;
  try {
    this.symbolTable.addSymbol(optBaseName, optBaseType);
    this.instructions.push(new CopyInstruction(optBase, objTemp));
    // Propagate inline instance tracking from objTemp to optBase
    this.maybeTrackInlineInstanceAssignment(optBase, objTemp, false);
    propResult = this.visitPropertyAccessExpression({
      kind: ASTNodeKind.PropertyAccessExpression,
      object: {
        kind: ASTNodeKind.Identifier,
        name: optBaseName,
      } as IdentifierNode,
      property: node.property,
    } as PropertyAccessExpressionNode);
  } finally {
    this.symbolTable.exitScope();
  }
  this.emitCopyWithTracking(result, propResult);
  this.instructions.push(new LabelInstruction(endLabel));

  return result;
}

const NUMERIC_UDON_TYPES = new Set([
  UdonType.Byte,
  UdonType.SByte,
  UdonType.Int16,
  UdonType.UInt16,
  UdonType.Int32,
  UdonType.UInt32,
  UdonType.Int64,
  UdonType.UInt64,
  UdonType.Single,
  UdonType.Double,
]);

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
  const srcType = this.getOperandType(operand);
  // Use CastInstruction for numeric type conversions (e.g. float→int);
  // use COPY for same-type or reference-type casts.
  if (
    srcType.udonType !== targetTypeSymbol.udonType &&
    NUMERIC_UDON_TYPES.has(srcType.udonType) &&
    NUMERIC_UDON_TYPES.has(targetTypeSymbol.udonType)
  ) {
    this.instructions.push(new CastInstruction(result, operand));
  } else {
    this.emitCopyWithTracking(result, operand);
  }
  return result;
}

export function visitNameofExpression(
  this: ASTToTACConverter,
  node: NameofExpressionNode,
): TACOperand {
  return createConstant(node.name, PrimitiveTypes.string);
}

const SHORT_TO_DOTNET_TYPE: Record<string, string> = {
  float: "System.Single",
  int: "System.Int32",
  bool: "System.Boolean",
  string: "System.String",
  double: "System.Double",
  object: "System.Object",
  byte: "System.Byte",
  sbyte: "System.SByte",
  short: "System.Int16",
  ushort: "System.UInt16",
  uint: "System.UInt32",
  long: "System.Int64",
  ulong: "System.UInt64",
};

export function visitTypeofExpression(
  this: ASTToTACConverter,
  node: TypeofExpressionNode,
): TACOperand {
  const qualifiedName = SHORT_TO_DOTNET_TYPE[node.typeName] ?? node.typeName;
  const typeNameConst = createConstant(qualifiedName, PrimitiveTypes.string);
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

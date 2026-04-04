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
  type ASTNode,
  ASTNodeKind,
  type AssignmentExpressionNode,
  type IdentifierNode,
  needsInt32IndexCoercion,
  type PropertyAccessExpressionNode,
  UdonType,
  type UpdateExpressionNode,
} from "../../../frontend/types.js";
import {
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
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  type ConstantOperand,
  createConstant,
  createVariable,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";
import { resolveClassNode, resolveClassProperty } from "./inline.js";

export function assignToTarget(
  this: ASTToTACConverter,
  target: ASTNode,
  value: TACOperand,
): TACOperand {
  if (target.kind === ASTNodeKind.ArrayAccessExpression) {
    const arrayAccess = target as ArrayAccessExpressionNode;
    const array = this.visitExpression(arrayAccess.array);
    const index = this.visitExpression(arrayAccess.index);
    const arrayType = this.getOperandType(array);
    if (arrayType instanceof CollectionTypeSymbol) {
      this.instructions.push(
        new MethodCallInstruction(undefined, array, "set_Item", [index, value]),
      );
      return value;
    }
    if (
      arrayType instanceof DataListTypeSymbol ||
      arrayType.name === ExternTypes.dataList.name
    ) {
      // Coerce index to Int32 for DataList.set_Item (expects SystemInt32)
      let coercedIndex = index;
      const indexType = this.getOperandType(index);
      if (needsInt32IndexCoercion(indexType.udonType)) {
        const intIndex = this.newTemp(PrimitiveTypes.int32);
        this.instructions.push(new CastInstruction(intIndex, index));
        coercedIndex = intIndex;
      }
      const token = this.wrapDataToken(value);
      this.instructions.push(
        new MethodCallInstruction(undefined, array, "set_Item", [
          coercedIndex,
          token,
        ]),
      );
      return value;
    }
    this.instructions.push(new ArrayAssignmentInstruction(array, index, value));
    return value;
  }

  if (target.kind === ASTNodeKind.PropertyAccessExpression) {
    const propAccess = target as PropertyAccessExpressionNode;
    if (
      propAccess.object.kind === ASTNodeKind.ThisExpression &&
      this.currentInlineContext &&
      !this.currentThisOverride
    ) {
      const mapped = this.mapInlineProperty(
        this.currentInlineContext.className,
        this.currentInlineContext.instancePrefix,
        propAccess.property,
      );
      if (mapped) {
        this.emitCopyWithTracking(mapped, value);
        return value;
      }
    }
    // Entry point class self-property WRITE: direct copy
    if (
      propAccess.object.kind === ASTNodeKind.ThisExpression &&
      this.currentClassName &&
      this.entryPointClasses.has(this.currentClassName) &&
      !this.currentInlineContext &&
      !this.currentThisOverride
    ) {
      const resolved = resolveClassProperty(
        this,
        this.currentClassName,
        propAccess.property,
      );
      if (resolved) {
        const targetVar = createVariable(
          this.entryPointPropName(propAccess.property),
          resolved.prop.type,
        );
        this.emitCopyWithTracking(targetVar, value);
        const callback = this.resolveFieldChangeCallback(
          propAccess.object,
          propAccess.property,
        );
        if (callback) {
          // Try to inline the callback method; fall back to MethodCallInstruction
          const inlined = this.visitInlineInstanceMethodCall(
            this.currentClassName,
            callback,
            [],
          );
          if (inlined == null) {
            const thisVar = createVariable(
              "this",
              this.typeMapper.mapTypeScriptType(this.currentClassName),
            );
            this.instructions.push(
              new MethodCallInstruction(undefined, thisVar, callback, []),
            );
          }
        }
        return value;
      }
    }
    // Static property write on inline classes: ClassName.staticField = value
    if (propAccess.object.kind === ASTNodeKind.Identifier) {
      const objectName = (propAccess.object as IdentifierNode).name;
      if (
        !this.symbolTable.lookup(objectName) && // not shadowed by a local
        resolveClassNode(this, objectName) &&
        !this.udonBehaviourClasses.has(objectName)
      ) {
        const mapped = this.mapStaticProperty(objectName, propAccess.property);
        if (mapped) {
          this.emitCopyWithTracking(mapped, value);
          return value;
        }
      }
    }
    if (propAccess.object.kind === ASTNodeKind.Identifier) {
      const instanceInfo = this.resolveInlineInstance(
        (propAccess.object as IdentifierNode).name,
      );
      if (instanceInfo) {
        const mapped = this.mapInlineProperty(
          instanceInfo.className,
          instanceInfo.prefix,
          propAccess.property,
        );
        if (mapped) {
          this.emitCopyWithTracking(mapped, value);
          return value;
        }
      }
    }
    if (this.isUdonBehaviourPropertyAccess(propAccess)) {
      const object = this.visitExpression(propAccess.object);
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
      this.instructions.push(
        new CallInstruction(undefined, externSig, [object, propName, value]),
      );
      return value;
    }
    const object = this.visitExpression(propAccess.object);
    // Post-evaluation inline instance resolution for WRITE
    if (object.kind === TACOperandKind.Variable) {
      const instanceInfo = this.resolveInlineInstance(
        (object as VariableOperand).name,
      );
      if (instanceInfo) {
        const mapped = this.mapInlineProperty(
          instanceInfo.className,
          instanceInfo.prefix,
          propAccess.property,
        );
        if (mapped) {
          this.emitCopyWithTracking(mapped, value);
          return value;
        }
      }
    }
    // Array length setter: array.length = n → array = array.slice(0, n)
    const objectType = this.getOperandType(object);
    if (
      propAccess.property === "length" &&
      objectType instanceof ArrayTypeSymbol &&
      object.kind === TACOperandKind.Variable
    ) {
      const sliced = this.newTemp(objectType);
      this.instructions.push(
        new MethodCallInstruction(sliced, object, "slice", [
          createConstant(0, PrimitiveTypes.int32),
          value,
        ]),
      );
      this.instructions.push(
        new CopyInstruction(object as VariableOperand, sliced),
      );
      return value;
    }
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
  this.emitCopyWithTracking(targetOperand, value);
  return targetOperand;
}

export function visitAssignmentExpression(
  this: ASTToTACConverter,
  node: AssignmentExpressionNode,
): TACOperand {
  // Propagate expected type for typed object literal re-assignments
  if (
    node.value.kind === ASTNodeKind.ObjectLiteralExpression &&
    node.target.kind === ASTNodeKind.Identifier
  ) {
    const sym = this.symbolTable.lookup((node.target as IdentifierNode).name);
    if (
      sym &&
      sym.type instanceof InterfaceTypeSymbol &&
      sym.type.properties.size > 0
    ) {
      const prev = this.currentExpectedType;
      this.currentExpectedType = sym.type;
      const value = this.visitExpression(node.value);
      this.currentExpectedType = prev;
      return this.assignToTarget(node.target, value);
    }
  }
  const value = this.visitExpression(node.value);
  return this.assignToTarget(node.target, value);
}

export function visitUpdateExpression(
  this: ASTToTACConverter,
  node: UpdateExpressionNode,
): TACOperand {
  const currentValue = this.visitExpression(node.operand);
  const resultType = this.getOperandType(currentValue);
  const delta = createConstant(1, resultType);

  const postfixSnapshot = node.isPostfix ? this.newTemp(resultType) : null;
  if (postfixSnapshot) {
    this.emitCopyWithTracking(postfixSnapshot, currentValue);
  }

  const newValue = this.newTemp(resultType);
  this.instructions.push(
    new BinaryOpInstruction(newValue, currentValue, node.operator, delta),
  );
  const assignedValue = this.assignToTarget(node.operand, newValue);
  return postfixSnapshot ?? assignedValue;
}

export function coerceConstantToType(
  this: ASTToTACConverter,
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

export function getArrayElementType(
  this: ASTToTACConverter,
  operand: TACOperand,
): TypeSymbol | null {
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

/**
 * Emit instructions for array concatenation using DataList operations.
 * Udon VM does not support native Array.concat or SystemObjectArray operations.
 * Creates a new DataList, iterates both source arrays (via DataList access
 * patterns), and adds each element as a DataToken.
 */
export function emitArrayConcat(
  converter: ASTToTACConverter,
  a: TACOperand,
  b: TACOperand,
): TACOperand {
  const dataListType = ExternTypes.dataList;
  // Cast both operands to DataList. In this transpiler, all user-facing
  // arrays are represented as DataList at runtime, so the COPY merely
  // reinterprets the heap type for the EXTERN resolver. If an operand is
  // already DataList-typed, skip the redundant copy.
  const aType = converter.getOperandType(a);
  let aList: TACOperand;
  if (
    aType instanceof DataListTypeSymbol ||
    aType.name === dataListType.name
  ) {
    aList = a;
  } else {
    aList = converter.newTemp(dataListType);
    converter.instructions.push(new CopyInstruction(aList, a));
  }
  const bType = converter.getOperandType(b);
  let bList: TACOperand;
  if (
    bType instanceof DataListTypeSymbol ||
    bType.name === dataListType.name
  ) {
    bList = b;
  } else {
    bList = converter.newTemp(dataListType);
    converter.instructions.push(new CopyInstruction(bList, b));
  }
  // Create new DataList for result
  const ctorExtern = converter.requireExternSignature(
    "DataList",
    "ctor",
    "method",
    [],
    "DataList",
  );
  const result = converter.newTemp(dataListType);
  converter.instructions.push(new CallInstruction(result, ctorExtern, []));
  // Get counts
  const lenA = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(new PropertyGetInstruction(lenA, aList, "Count"));
  const lenB = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(new PropertyGetInstruction(lenB, bList, "Count"));
  // Copy a elements: for (i = 0; i < lenA; i++) result.Add(a.get_Item(i))
  const idxA = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new AssignmentInstruction(idxA, createConstant(0, PrimitiveTypes.int32)),
  );
  const loopAStart = converter.newLabel("concat_a_start");
  const loopAEnd = converter.newLabel("concat_a_end");
  converter.instructions.push(new LabelInstruction(loopAStart));
  const condA = converter.newTemp(PrimitiveTypes.boolean);
  converter.instructions.push(new BinaryOpInstruction(condA, idxA, "<", lenA));
  converter.instructions.push(new ConditionalJumpInstruction(condA, loopAEnd));
  const elemA = converter.newTemp(ExternTypes.dataToken);
  converter.instructions.push(
    new MethodCallInstruction(elemA, aList, "get_Item", [idxA]),
  );
  converter.instructions.push(
    new MethodCallInstruction(undefined, result, "Add", [elemA]),
  );
  const nextA = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new BinaryOpInstruction(
      nextA,
      idxA,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  converter.emitCopyWithTracking(idxA, nextA);
  converter.instructions.push(new UnconditionalJumpInstruction(loopAStart));
  converter.instructions.push(new LabelInstruction(loopAEnd));
  // Copy b elements
  const idxB = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new AssignmentInstruction(idxB, createConstant(0, PrimitiveTypes.int32)),
  );
  const loopBStart = converter.newLabel("concat_b_start");
  const loopBEnd = converter.newLabel("concat_b_end");
  converter.instructions.push(new LabelInstruction(loopBStart));
  const condB = converter.newTemp(PrimitiveTypes.boolean);
  converter.instructions.push(new BinaryOpInstruction(condB, idxB, "<", lenB));
  converter.instructions.push(new ConditionalJumpInstruction(condB, loopBEnd));
  const elemB = converter.newTemp(ExternTypes.dataToken);
  converter.instructions.push(
    new MethodCallInstruction(elemB, bList, "get_Item", [idxB]),
  );
  converter.instructions.push(
    new MethodCallInstruction(undefined, result, "Add", [elemB]),
  );
  const nextB = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new BinaryOpInstruction(
      nextB,
      idxB,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  converter.emitCopyWithTracking(idxB, nextB);
  converter.instructions.push(new UnconditionalJumpInstruction(loopBStart));
  converter.instructions.push(new LabelInstruction(loopBEnd));
  return result;
}

export function wrapDataToken(
  this: ASTToTACConverter,
  value: TACOperand,
): TACOperand {
  const valueType = this.getOperandType(value);
  if (valueType.name === ExternTypes.dataToken.name) {
    return value;
  }
  const token = this.newTemp(ExternTypes.dataToken);
  const externSig = this.requireExternSignature(
    "DataToken",
    "ctor",
    "method",
    [valueType.name],
    "DataToken",
  );
  this.instructions.push(new CallInstruction(token, externSig, [value]));
  return token;
}

export function unwrapDataToken(
  this: ASTToTACConverter,
  token: TACOperand,
  targetType: TypeSymbol,
): TACOperand {
  const tokenType = this.getOperandType(token);
  if (tokenType.name !== ExternTypes.dataToken.name) {
    return token;
  }

  let property = "Reference";
  switch (targetType.udonType) {
    case UdonType.String:
      property = "String";
      break;
    case UdonType.Boolean:
      property = "Boolean";
      break;
    case UdonType.Int32:
    case UdonType.Int16:
    case UdonType.UInt16:
    case UdonType.UInt32:
    case UdonType.Byte:
    case UdonType.SByte:
      property = "Int";
      break;
    case UdonType.Int64:
    case UdonType.UInt64:
      property = "Long";
      break;
    case UdonType.Single:
      property = "Float";
      break;
    case UdonType.Double:
      property = "Double";
      break;
    case UdonType.DataList:
      property = "DataList";
      break;
    case UdonType.DataDictionary:
      property = "DataDictionary";
      break;
    default:
      property = "Reference";
      break;
  }

  const result = this.newTemp(targetType);
  this.instructions.push(new PropertyGetInstruction(result, token, property));
  return result;
}

export function getOperandType(
  this: ASTToTACConverter,
  operand: TACOperand,
): TypeSymbol {
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

export function isNullableType(
  this: ASTToTACConverter,
  type: TypeSymbol,
): boolean {
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

export function isStatementNode(
  this: ASTToTACConverter,
  node: ASTNode,
): boolean {
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

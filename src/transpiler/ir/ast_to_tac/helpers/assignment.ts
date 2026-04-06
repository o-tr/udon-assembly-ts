import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ArrayTypeSymbol,
  ClassTypeSymbol,
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
 * Coerce an operand to a native SystemObjectArray. If the operand is
 * already an ArrayTypeSymbol, a simple COPY reinterprets the heap type.
 * If it is a DataList, emit a loop that reads each element via
 * DataList.get_Item, unwraps the DataToken, and writes to a fresh
 * native array via ArrayAssignmentInstruction.
 * Returns [arrayOperand, lengthOperand].
 */
function coerceToNativeArray(
  converter: ASTToTACConverter,
  operand: TACOperand,
  objArrayType: ArrayTypeSymbol,
): [TACOperand, TACOperand] {
  const opType = converter.getOperandType(operand);
  const isAliasChainBackedByArrayLiteral = (startName: string): boolean => {
    const visited = new Set<string>();
    let current = startName;
    while (true) {
      if (visited.has(current)) return false;
      visited.add(current);
      const symbol = converter.symbolTable.lookup(current);
      const initialValue = symbol?.initialValue as ASTNode | undefined;
      if (!initialValue) return false;
      if (initialValue.kind === ASTNodeKind.ArrayLiteralExpression) return true;
      if (initialValue.kind !== ASTNodeKind.Identifier) return false;
      current = (initialValue as IdentifierNode).name;
    }
  };
  const isDeclaredDataList =
    opType instanceof DataListTypeSymbol ||
    opType.name === ExternTypes.dataList.name ||
    opType.udonType === UdonType.DataList;
  const isArrayLiteralBackedDataList =
    operand.kind === TACOperandKind.Variable &&
    opType instanceof ArrayTypeSymbol &&
    (() => {
      const symbol = converter.symbolTable.lookup(
        (operand as VariableOperand).name,
      );
      // Safety: this heuristic is only reliable for const aliases because
      // let/var can be reassigned after declaration.
      if (!symbol?.isConstant) return false;
      return isAliasChainBackedByArrayLiteral(
        (operand as VariableOperand).name,
      );
    })();
  const isDataList = isDeclaredDataList || isArrayLiteralBackedDataList;

  if (!isDataList) {
    // Native array — cast and get length
    const arr = converter.newTemp(objArrayType);
    converter.instructions.push(new CopyInstruction(arr, operand));
    const len = converter.newTemp(PrimitiveTypes.int32);
    // Udon extern is get_Length (capital L), not get_length.
    converter.instructions.push(new PropertyGetInstruction(len, arr, "Length"));
    return [arr, len];
  }

  // DataList — get Count, create native array, copy elements via loop.
  // Skip redundant COPY if operand is already DataList-typed.
  let list: TACOperand;
  if (opType instanceof DataListTypeSymbol) {
    list = operand;
  } else {
    list = converter.newTemp(ExternTypes.dataList);
    converter.instructions.push(new CopyInstruction(list, operand));
  }
  const len = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(new PropertyGetInstruction(len, list, "Count"));
  const ctorExtern = converter.requireExternSignature(
    "object[]",
    "ctor",
    "method",
    ["int"],
    "object[]",
  );
  const arr = converter.newTemp(objArrayType);
  converter.instructions.push(new CallInstruction(arr, ctorExtern, [len]));

  // for (i = 0; i < len; i++) arr[i] = list.get_Item(i).Reference
  const idx = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new AssignmentInstruction(idx, createConstant(0, PrimitiveTypes.int32)),
  );
  const loopStart = converter.newLabel("dl2arr_start");
  const loopEnd = converter.newLabel("dl2arr_end");
  converter.instructions.push(new LabelInstruction(loopStart));
  const cond = converter.newTemp(PrimitiveTypes.boolean);
  converter.instructions.push(new BinaryOpInstruction(cond, idx, "<", len));
  // JUMP_IF_FALSE: exit when idx >= len
  converter.instructions.push(new ConditionalJumpInstruction(cond, loopEnd));
  const token = converter.newTemp(ExternTypes.dataToken);
  converter.instructions.push(
    new MethodCallInstruction(token, list, "get_Item", [idx]),
  );
  const unwrapTargetType = (() => {
    if (opType instanceof DataListTypeSymbol) return opType.elementType;
    if (opType instanceof ArrayTypeSymbol) return opType.elementType;
    return ObjectType;
  })();
  const isInlineHandleType =
    (unwrapTargetType instanceof ClassTypeSymbol &&
      converter.classMap.has(unwrapTargetType.name) &&
      !converter.udonBehaviourClasses.has(unwrapTargetType.name)) ||
    (unwrapTargetType instanceof InterfaceTypeSymbol &&
      converter.interfaceClassIdMap.has(unwrapTargetType.name));
  // Inline class arrays are stored as int handles inside DataToken; using
  // .Reference can trigger unsupported externs on some UdonVM builds.
  const elem = isInlineHandleType
    ? (() => {
        const handle = converter.newTemp(PrimitiveTypes.int32);
        converter.instructions.push(
          new PropertyGetInstruction(handle, token, "Int"),
        );
        return handle;
      })()
    : converter.unwrapDataToken(token, unwrapTargetType);
  converter.instructions.push(new ArrayAssignmentInstruction(arr, idx, elem));
  const next = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new BinaryOpInstruction(
      next,
      idx,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  converter.instructions.push(new CopyInstruction(idx, next));
  converter.instructions.push(new UnconditionalJumpInstruction(loopStart));
  converter.instructions.push(new LabelInstruction(loopEnd));

  return [arr, len];
}

/**
 * Emit instructions for array concatenation using native Array.Copy.
 * Accepts both native arrays and DataList operands (auto-coerced).
 * Creates a new SystemObjectArray of size a.length + b.length, then
 * copies elements from both sources using SystemArray.Copy.
 */
export function emitArrayConcat(
  converter: ASTToTACConverter,
  a: TACOperand,
  b: TACOperand,
): TACOperand {
  const objArrayType = new ArrayTypeSymbol(ObjectType);

  // Coerce both operands to native SystemObjectArray (handles DataList)
  const [aArr, lenA] = coerceToNativeArray(converter, a, objArrayType);
  const [bArr, lenB] = coerceToNativeArray(converter, b, objArrayType);

  // totalLen = lenA + lenB
  const totalLen = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new BinaryOpInstruction(totalLen, lenA, "+", lenB),
  );

  // result = new Object[totalLen]
  const ctorExtern = converter.requireExternSignature(
    "object[]",
    "ctor",
    "method",
    ["int"],
    "object[]",
  );
  const result = converter.newTemp(objArrayType);
  converter.instructions.push(
    new CallInstruction(result, ctorExtern, [totalLen]),
  );

  // SystemArray.Copy(a, 0L, result, 0L, lenA64)
  const copyExtern = converter.requireExternSignature(
    "SystemArray",
    "Copy",
    "method",
    ["SystemArray", "long", "SystemArray", "long", "long"],
    "void",
  );
  const zero64 = createConstant(0n, PrimitiveTypes.int64);
  const lenA64 = converter.newTemp(PrimitiveTypes.int64);
  const lenB64 = converter.newTemp(PrimitiveTypes.int64);
  converter.instructions.push(new CastInstruction(lenA64, lenA));
  converter.instructions.push(new CastInstruction(lenB64, lenB));
  converter.instructions.push(
    new CallInstruction(undefined, copyExtern, [
      aArr,
      zero64,
      result,
      zero64,
      lenA64,
    ]),
  );

  // SystemArray.Copy(b, 0L, result, lenA64, lenB64)
  converter.instructions.push(
    new CallInstruction(undefined, copyExtern, [
      bArr,
      zero64,
      result,
      lenA64,
      lenB64,
    ]),
  );

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

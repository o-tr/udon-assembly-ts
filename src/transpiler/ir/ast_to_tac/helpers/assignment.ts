import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  ArrayTypeSymbol,
  CollectionTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  GenericTypeParameterSymbol,
  InterfaceTypeSymbol,
  NativeArrayTypeSymbol,
  ObjectType,
  ObjectTypeSymbol,
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
import {
  isInlineHandleType,
  resolveClassNode,
  resolveClassProperty,
  resolveInlineClassType,
} from "./inline.js";

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
    // Native array path: emit ArrayAssignmentInstruction (no DataToken wrapping).
    if (arrayType instanceof NativeArrayTypeSymbol) {
      // Coerce index to Int32 (native array __Set__ expects SystemInt32).
      let nativeIndex = index;
      const nativeIdxType = this.getOperandType(index);
      if (needsInt32IndexCoercion(nativeIdxType.udonType)) {
        const intIndex = this.newTemp(PrimitiveTypes.int32);
        this.instructions.push(new CastInstruction(intIndex, index));
        nativeIndex = intIndex;
      }
      this.instructions.push(
        new ArrayAssignmentInstruction(array, nativeIndex, value),
      );
      return value;
    }
    // All array types (ArrayTypeSymbol, DataListTypeSymbol, untyped DataList)
    // use DataList.set_Item + DataToken wrapping. CollectionTypeSymbol (Map/Set)
    // is handled above and does not need DataToken wrapping.
    let coercedIndex = index;
    const idxType = this.getOperandType(index);
    if (needsInt32IndexCoercion(idxType.udonType)) {
      const intIndex = this.newTemp(PrimitiveTypes.int32);
      this.instructions.push(new CastInstruction(intIndex, index));
      coercedIndex = intIndex;
    }
    // Bounds-check-and-grow loop: ensure Count > coercedIndex before set_Item.
    // DataList.set_Item throws IndexOutOfRange if the index does not already
    // exist, so we grow the list with Add until it is large enough.
    // DataToken is a C# struct (value type) — DataList.Add copies the value,
    // so reusing the same heap slot for defaultToken across iterations is safe.
    const defaultToken = this.wrapDataToken(
      createConstant(0, PrimitiveTypes.int32),
    );
    const dlgrowStart = this.newLabel("dlgrow_start");
    const dlgrowEnd = this.newLabel("dlgrow_end");
    this.instructions.push(new LabelInstruction(dlgrowStart));
    const currentCount = this.newTemp(PrimitiveTypes.int32);
    this.instructions.push(
      new PropertyGetInstruction(currentCount, array, "Count"),
    );
    const needsGrow = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new BinaryOpInstruction(needsGrow, currentCount, "<=", coercedIndex),
    );
    this.instructions.push(
      new ConditionalJumpInstruction(needsGrow, dlgrowEnd),
    );
    this.instructions.push(
      new MethodCallInstruction(undefined, array, "Add", [defaultToken]),
    );
    this.instructions.push(new UnconditionalJumpInstruction(dlgrowStart));
    this.instructions.push(new LabelInstruction(dlgrowEnd));

    const token = this.wrapDataToken(value);
    this.instructions.push(
      new MethodCallInstruction(undefined, array, "set_Item", [
        coercedIndex,
        token,
      ]),
    );
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
    // Array length setter: array.length = n → array = array.GetRange(0, n)
    const objectType = this.getOperandType(object);
    if (
      propAccess.property === "length" &&
      (objectType instanceof ArrayTypeSymbol ||
        objectType instanceof DataListTypeSymbol) &&
      object.kind === TACOperandKind.Variable
    ) {
      const sliced = this.newTemp(objectType);
      let coercedValue = value;
      const valueType = this.getOperandType(value);
      if (needsInt32IndexCoercion(valueType.udonType)) {
        const intValue = this.newTemp(PrimitiveTypes.int32);
        this.instructions.push(new CastInstruction(intValue, value));
        coercedValue = intValue;
      }
      this.instructions.push(
        new MethodCallInstruction(sliced, object, "GetRange", [
          createConstant(0, PrimitiveTypes.int32),
          coercedValue,
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
    if (type instanceof NativeArrayTypeSymbol) {
      return type.elementType;
    }
  }
  return null;
}

type AliasLikeSymbol = { initialValue?: unknown };

function _isAliasChainBackedByArrayLiteral(
  startName: string,
  lookupSymbol: (name: string) => AliasLikeSymbol | undefined,
  firstSymbol?: AliasLikeSymbol,
): boolean {
  const visited = new Set<string>();
  let current = startName;
  let currentSymbol = firstSymbol;
  while (true) {
    if (visited.has(current)) return false;
    visited.add(current);
    const symbol = currentSymbol ?? lookupSymbol(current);
    const initialValue = symbol?.initialValue as ASTNode | undefined;
    if (!initialValue) return false;
    if (initialValue.kind === ASTNodeKind.ArrayLiteralExpression) return true;
    if (initialValue.kind !== ASTNodeKind.Identifier) return false;
    current = (initialValue as IdentifierNode).name;
    currentSymbol = undefined;
  }
}

/**
 * Emit a DataList-based loop that copies elements from `source` into `dest`.
 * `source` can be a DataList or ArrayTypeSymbol (both backed by DataList at runtime).
 * Elements are copied as DataTokens (get_Item → Add) with no unwrap/rewrap.
 */
function emitCopyElementsLoop(
  converter: ASTToTACConverter,
  source: TACOperand,
  dest: TACOperand,
): void {
  const len = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(new PropertyGetInstruction(len, source, "Count"));

  const idx = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new AssignmentInstruction(idx, createConstant(0, PrimitiveTypes.int32)),
  );
  const loopStart = converter.newLabel("dlconcat_start");
  const loopEnd = converter.newLabel("dlconcat_end");
  converter.instructions.push(new LabelInstruction(loopStart));
  const cond = converter.newTemp(PrimitiveTypes.boolean);
  converter.instructions.push(new BinaryOpInstruction(cond, idx, "<", len));
  converter.instructions.push(new ConditionalJumpInstruction(cond, loopEnd));

  // token = source.get_Item(idx)
  const token = converter.newTemp(ExternTypes.dataToken);
  converter.instructions.push(
    new MethodCallInstruction(token, source, "get_Item", [idx]),
  );
  // dest.Add(token)
  converter.instructions.push(
    new MethodCallInstruction(undefined, dest, "Add", [token]),
  );

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
}

/**
 * Emit instructions for array concatenation using DataList.
 * Creates a new DataList, copies elements from both sources via
 * get_Item/Add loops. Returns a DataList operand.
 */
export function emitArrayConcat(
  converter: ASTToTACConverter,
  a: TACOperand,
  b: TACOperand,
): TACOperand {
  // Determine element type for the result DataList
  const aType = converter.getOperandType(a);
  const bType = converter.getOperandType(b);
  const elementType =
    aType instanceof DataListTypeSymbol
      ? aType.elementType
      : aType instanceof ArrayTypeSymbol
        ? aType.elementType
        : bType instanceof DataListTypeSymbol
          ? bType.elementType
          : bType instanceof ArrayTypeSymbol
            ? bType.elementType
            : ObjectType;

  const resultType = new DataListTypeSymbol(elementType);
  const result = converter.newTemp(resultType);

  // result = new DataList()
  const ctorExtern = converter.requireExternSignature(
    "DataList",
    "ctor",
    "method",
    [],
    "DataList",
  );
  converter.instructions.push(new CallInstruction(result, ctorExtern, []));

  // Copy all elements from a, then from b
  emitCopyElementsLoop(converter, a, result);
  emitCopyElementsLoop(converter, b, result);

  return result;
}

export function wrapDataToken(
  this: ASTToTACConverter,
  value: TACOperand,
): TACOperand {
  let valueType = this.getOperandType(value);
  if (valueType.name === ExternTypes.dataToken.name) {
    return value;
  }
  // Inline class instances are stored as Int32 handles. Wrap as Int32
  // so they can be unwrapped via DataToken.Int later.
  if (isInlineHandleType(this, valueType)) {
    const handle = this.newTemp(PrimitiveTypes.int32);
    this.instructions.push(new CopyInstruction(handle, value));
    value = handle;
    valueType = PrimitiveTypes.int32;
  }
  // Arrays are DataLists at the Udon VM level. Wrap via DataList constructor
  // so DataToken stores the correct token type for later .DataList unwrap.
  if (valueType.udonType === UdonType.Array) {
    valueType = ExternTypes.dataList;
  }
  if (valueType.udonType === UdonType.NativeArray) {
    throw new Error(
      `[native-array] wrapDataToken called on NativeArrayTypeSymbol (${valueType.name}). ` +
        "This is a bug in native array eligibility analysis.",
    );
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

  // Upgrade ClassTypeSymbol(name, Object) → ClassTypeSymbol(name, Int32) for
  // known inline classes so the unwrap temp is declared as %SystemInt32 (the
  // actual slot type of get_Int), not %SystemObject. Without this, downstream
  // code reading the temp will round-trip via SystemConvert.ToInt32(Object)
  // and may hit a type-mismatch crash at runtime.
  targetType = resolveInlineClassType(this, targetType);

  // When the target type cannot determine the correct DataToken accessor
  // at compile time, return the DataToken as-is to avoid a .Reference
  // crash on non-reference tokens. This covers:
  //   - ObjectTypeSymbol: unknown/any/object (erased top type)
  //   - GenericTypeParameterSymbol: unresolved generic params (T, K, V)
  //   - DataToken: target already IS a DataToken, no unwrap needed
  if (
    targetType instanceof ObjectTypeSymbol ||
    targetType instanceof GenericTypeParameterSymbol ||
    targetType.udonType === UdonType.DataToken
  ) {
    return token;
  }

  // Inline class instances are stored as Int32 handles in DataToken.
  // Must unwrap via .Int, not .Reference, to avoid Udon VM errors.
  let property = "Reference";
  if (isInlineHandleType(this, targetType)) {
    property = "Int";
  } else {
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
      case UdonType.Array:
        property = "DataList";
        break;
      case UdonType.DataDictionary:
        property = "DataDictionary";
        break;
      default:
        property = "Reference";
        break;
    }
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

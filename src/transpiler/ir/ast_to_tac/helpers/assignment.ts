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
  type ASTNode,
  ASTNodeKind,
  type AssignmentExpressionNode,
  type IdentifierNode,
  type PropertyAccessExpressionNode,
  UdonType,
  type UpdateExpressionNode,
} from "../../../frontend/types.js";
import {
  ArrayAssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  CopyInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  PropertySetInstruction,
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
      const token = this.wrapDataToken(value);
      this.instructions.push(
        new MethodCallInstruction(undefined, array, "set_Item", [index, token]),
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
    // Entry point class self-property WRITE: direct copy
    if (
      propAccess.object.kind === ASTNodeKind.ThisExpression &&
      this.currentClassName &&
      this.entryPointClasses.has(this.currentClassName) &&
      !this.currentInlineContext &&
      !this.currentThisOverride
    ) {
      const classNode = this.classMap.get(this.currentClassName);
      const prop = classNode?.properties.find(
        (p) => p.name === propAccess.property,
      );
      if (prop) {
        const targetVar = createVariable(propAccess.property, prop.type);
        this.instructions.push(new CopyInstruction(targetVar, value));
        this.maybeTrackInlineInstanceAssignment(targetVar, value);
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
      const instanceInfo = this.inlineInstanceMap.get(
        (object as VariableOperand).name,
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

export function visitAssignmentExpression(
  this: ASTToTACConverter,
  node: AssignmentExpressionNode,
): TACOperand {
  const value = this.visitExpression(node.value);
  return this.assignToTarget(node.target, value);
}

export function visitUpdateExpression(
  this: ASTToTACConverter,
  node: UpdateExpressionNode,
): TACOperand {
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

import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import { UdonType } from "../../../frontend/types.js";
import { CastInstruction } from "../../tac_instruction.js";
import { type ConstantOperand, type TACOperand, TACOperandKind } from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

export function coerceSwitchOperand(
  this: ASTToTACConverter,
  operand: TACOperand,
  targetType: TypeSymbol,
): TACOperand {
  const sourceType = this.getOperandType(operand);
  if (sourceType.udonType === targetType.udonType) {
    return operand;
  }

  if (operand.kind === TACOperandKind.Constant) {
    const constant = operand as ConstantOperand;
    const coerced = this.coerceConstantToType(constant, targetType);
    if (coerced) return coerced;
  }

  if (
    this.isSwitchComparableType(sourceType) &&
    this.isSwitchComparableType(targetType)
  ) {
    const casted = this.newTemp(targetType);
    this.instructions.push(new CastInstruction(casted, operand));
    return casted;
  }

  return operand;
}

export function isSwitchComparableType(
  this: ASTToTACConverter,
  type: TypeSymbol
): boolean {
  switch (type.udonType) {
    case UdonType.Int32:
    case UdonType.UInt32:
    case UdonType.Int16:
    case UdonType.UInt16:
    case UdonType.Int64:
    case UdonType.UInt64:
    case UdonType.Byte:
    case UdonType.SByte:
    case UdonType.Single:
    case UdonType.Double:
    case UdonType.String:
    case UdonType.Boolean:
      return true;
    default:
      return false;
  }
}

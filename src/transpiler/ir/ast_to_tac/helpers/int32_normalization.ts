import { ExternTypes, PrimitiveTypes } from "../../../frontend/type_symbols.js";
import { UdonType } from "../../../frontend/types.js";
import { CastInstruction } from "../../tac_instruction.js";
import { TACOperandKind, type TACOperand } from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

/**
 * Normalize an operand to Int32 for index/handle comparisons.
 * DataToken operands are first unwrapped as Int32, then explicitly cast.
 */
export function normalizeOperandToInt32(
  converter: ASTToTACConverter,
  operand: TACOperand,
): TACOperand {
  let normalized = operand;
  const sourceType = converter.getOperandType(normalized);
  if (
    sourceType.udonType === UdonType.DataToken ||
    sourceType.name === ExternTypes.dataToken.name
  ) {
    normalized = converter.unwrapDataToken(normalized, PrimitiveTypes.int32);
  }

  const normalizedType = converter.getOperandType(normalized);
  if (normalizedType.udonType === UdonType.Int32) {
    // Keep constants as-is, but force a cast for variables/temps so the value
    // is re-materialized into a guaranteed Int32 slot right before use.
    if (normalized.kind === TACOperandKind.Constant) {
      return normalized;
    }
  }

  const casted = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(new CastInstruction(casted, normalized));
  return casted;
}

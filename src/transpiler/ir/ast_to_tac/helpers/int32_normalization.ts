import { ExternTypes, PrimitiveTypes } from "../../../frontend/type_symbols.js";
import { UdonType } from "../../../frontend/types.js";
import { CastInstruction } from "../../tac_instruction.js";
import { type TACOperand, TACOperandKind } from "../../tac_operand.js";
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
  const sourceWasErased =
    sourceType.udonType === UdonType.DataToken ||
    sourceType.name === ExternTypes.dataToken.name ||
    sourceType.udonType === UdonType.Object;
  if (
    sourceType.udonType === UdonType.DataToken ||
    sourceType.name === ExternTypes.dataToken.name
  ) {
    normalized = converter.unwrapDataToken(normalized, PrimitiveTypes.int32);
  }

  const normalizedType = converter.getOperandType(normalized);
  if (normalizedType.udonType === UdonType.Int32) {
    // Keep already-typed Int32 values as-is to avoid redundant ToInt32 calls.
    // Re-materialize only when coming from erased/object-like sources.
    if (normalized.kind === TACOperandKind.Constant || !sourceWasErased) {
      return normalized;
    }
  }

  const casted = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(new CastInstruction(casted, normalized));
  return casted;
}

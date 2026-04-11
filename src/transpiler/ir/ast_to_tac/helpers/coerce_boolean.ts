import { ObjectType, PrimitiveTypes } from "../../../frontend/type_symbols.js";
import { UdonType, isNumericUdonType } from "../../../frontend/types.js";
import {
  BinaryOpInstruction,
  PropertyGetInstruction,
} from "../../tac_instruction.js";
import {
  type TACOperand,
  TACOperandKind,
  createConstant,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

/**
 * Coerce a TAC operand to Boolean for use in ConditionalJumpInstruction.
 *
 * The Udon VM requires Boolean for JUMP_IF_FALSE. JS truthy semantics:
 * - Boolean → pass through
 * - String  → str.Length != 0
 * - Numeric → value != 0
 * - Other   → value != null
 */
export function coerceToBoolean(
  this: ASTToTACConverter,
  operand: TACOperand,
): TACOperand {
  const type = this.getOperandType(operand);
  const udonType = type.udonType;

  // Already Boolean — no coercion needed
  if (udonType === UdonType.Boolean) {
    return operand;
  }

  // String → str.Length != 0
  if (udonType === UdonType.String) {
    const lenTemp = this.newTemp(PrimitiveTypes.int32);
    this.instructions.push(
      new PropertyGetInstruction(lenTemp, operand, "Length"),
    );

    const boolTemp = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new BinaryOpInstruction(
        boolTemp,
        lenTemp,
        "!=",
        createConstant(0, PrimitiveTypes.int32),
      ),
    );
    return boolTemp;
  }

  // Numeric → value != 0
  if (isNumericUdonType(udonType)) {
    const boolTemp = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new BinaryOpInstruction(boolTemp, operand, "!=", createConstant(0, type)),
    );
    return boolTemp;
  }

  // Object / Class / other → value != null
  const boolTemp = this.newTemp(PrimitiveTypes.boolean);
  this.instructions.push(
    new BinaryOpInstruction(
      boolTemp,
      operand,
      "!=",
      createConstant(null, ObjectType),
    ),
  );
  return boolTemp;
}

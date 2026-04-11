import { ObjectType, PrimitiveTypes } from "../../../frontend/type_symbols.js";
import { isNumericUdonType, UdonType } from "../../../frontend/types.js";
import {
  BinaryOpInstruction,
  CallInstruction,
  UnaryOpInstruction,
} from "../../tac_instruction.js";
import {
  type ConstantOperand,
  createConstant,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

/** Udon extern signature for System.String.IsNullOrEmpty */
const IS_NULL_OR_EMPTY_SIG =
  "SystemString.__IsNullOrEmpty__SystemString__SystemBoolean";

/**
 * Coerce a TAC operand to Boolean for use in ConditionalJumpInstruction.
 *
 * The Udon VM requires Boolean for JUMP_IF_FALSE. JS truthy semantics:
 * - Boolean  → pass through
 * - Constant → fold at compile time
 * - String   → !String.IsNullOrEmpty(str)
 * - Numeric  → value != 0
 * - Other    → value != null
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

  // Constant folding: evaluate truthiness at compile time
  if (operand.kind === TACOperandKind.Constant) {
    const value = (operand as ConstantOperand).value;
    let truthy: boolean;
    if (value === null || value === undefined) {
      truthy = false;
    } else if (typeof value === "boolean") {
      truthy = value;
    } else if (typeof value === "string") {
      truthy = value.length > 0;
    } else if (typeof value === "number") {
      truthy = value !== 0 && !Number.isNaN(value);
    } else if (typeof value === "bigint") {
      truthy = value !== 0n;
    } else {
      truthy = true;
    }
    return createConstant(truthy, PrimitiveTypes.boolean);
  }

  // String → !String.IsNullOrEmpty(str)  (null-safe)
  if (udonType === UdonType.String) {
    const isNullOrEmpty = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new CallInstruction(isNullOrEmpty, IS_NULL_OR_EMPTY_SIG, [operand]),
    );
    const boolTemp = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new UnaryOpInstruction(boolTemp, "!", isNullOrEmpty),
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

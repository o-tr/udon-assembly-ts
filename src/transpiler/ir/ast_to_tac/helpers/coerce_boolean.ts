import { ObjectType, PrimitiveTypes } from "../../../frontend/type_symbols.js";
import { isNumericUdonType, UdonType } from "../../../frontend/types.js";
import {
  BinaryOpInstruction,
  CallInstruction,
  CopyInstruction,
  UnaryOpInstruction,
} from "../../tac_instruction.js";
import {
  type ConstantOperand,
  createConstant,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";
import { isTrackedInlineHandleType, usesInlineNullSentinel } from "./inline.js";
import { normalizeOperandToInt32 } from "./int32_normalization.js";

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

  // Constant folding: evaluate truthiness at compile time.
  // NOTE: The number branch folds NaN to false (matching JS !!NaN === false),
  // but the runtime numeric path below emits `value != 0` which treats NaN as
  // truthy (IEEE 754: NaN != 0 → true). This is an intentional divergence;
  // see the runtime comment for rationale.
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
    this.emit(
      new CallInstruction(isNullOrEmpty, IS_NULL_OR_EMPTY_SIG, [operand]),
    );
    const boolTemp = this.newTemp(PrimitiveTypes.boolean);
    this.emit(new UnaryOpInstruction(boolTemp, "!", isNullOrEmpty));
    return boolTemp;
  }

  // Numeric → value != 0
  // NOTE: For Single/Double, IEEE 754 `NaN != 0` is true, so NaN is treated
  // as truthy here. JS semantics say NaN is falsy (!!NaN === false). A strict
  // fix would prepend a !Single.IsNaN(value) guard, but that adds an extra
  // EXTERN call on every float condition. Since NaN-as-condition is extremely
  // rare in VRChat scripts, we accept this divergence for now.
  if (isNumericUdonType(udonType)) {
    const boolTemp = this.newTemp(PrimitiveTypes.boolean);
    // Defensive: in practice `isInlineHandleType` returns true only for
    // ClassTypeSymbol / InterfaceTypeSymbol, both of which carry
    // `udonType = UdonType.Object` — they never reach this branch (they're
    // routed to `usesInlineNullSentinel` below). The guard remains so that a
    // future int-backed inline-class variant doesn't fall through to a
    // numeric `0` sentinel that would alias a valid handle. Type the
    // constant as Int32 explicitly (matching the sentinel branch below)
    // rather than as the operand's class symbol, which would emit a
    // codegen-typed constant and risk a slot-type mismatch.
    const isInlineHandle = isTrackedInlineHandleType(this, type);
    const falseValue = isInlineHandle ? -1 : 0;
    const falseConstantType = isInlineHandle ? PrimitiveTypes.int32 : type;
    this.emit(
      new BinaryOpInstruction(
        boolTemp,
        operand,
        "!=",
        createConstant(falseValue, falseConstantType),
      ),
    );
    return boolTemp;
  }

  if (usesInlineNullSentinel(this, type)) {
    const handle = normalizeOperandToInt32(this, operand);
    const boolTemp = this.newTemp(PrimitiveTypes.boolean);
    this.emit(
      new BinaryOpInstruction(
        boolTemp,
        handle,
        "!=",
        createConstant(-1, PrimitiveTypes.int32),
      ),
    );
    return boolTemp;
  }

  // Udon value-type structs (Vector3, Quaternion, Color, …) are C# structs
  // that can never be null. They have no null-comparison extern, so emitting
  // `value != null` would produce a runtime error. Treat as always-truthy.
  if (
    udonType === UdonType.Vector2 ||
    udonType === UdonType.Vector3 ||
    udonType === UdonType.Vector4 ||
    udonType === UdonType.Quaternion ||
    udonType === UdonType.Color ||
    udonType === UdonType.DataToken
  ) {
    return createConstant(true, PrimitiveTypes.boolean);
  }

  // Object / Class / other → value != null.  Box through a SystemObject temp
  // first: structural-union handles may be stored in typed reference slots
  // (DataList/DataDictionary) even after their TAC type has been widened to
  // Object.  Comparing that typed null directly to SystemObject null is not
  // reliable in Udon VM, but copying the reference into an Object slot gives
  // the null-comparison extern matching operands.
  const boolTemp = this.newTemp(PrimitiveTypes.boolean);
  const comparisonOperand = this.newTemp(ObjectType);
  this.emit(new CopyInstruction(comparisonOperand, operand));
  this.emit(
    new BinaryOpInstruction(
      boolTemp,
      comparisonOperand,
      "!=",
      createConstant(null, ObjectType),
    ),
  );
  return boolTemp;
}

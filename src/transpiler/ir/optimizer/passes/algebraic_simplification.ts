import { PrimitiveTypes } from "../../../frontend/type_symbols.js";
import { UdonType } from "../../../frontend/types.js";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  type CastInstruction,
  type TACInstruction,
  TACInstructionKind,
  type UnaryOpInstruction,
} from "../../tac_instruction.js";
import {
  type ConstantOperand,
  createConstant,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import { operandKey } from "../utils/operands.js";
import { getOperandType, isIntegerUdonType } from "./constant_folding.js";

export const algebraicSimplification = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const result: TACInstruction[] = [];

  for (const inst of instructions) {
    if (inst.kind === TACInstructionKind.BinaryOp) {
      const simplified = trySimplifyBinaryOp(inst as BinaryOpInstruction);
      if (simplified) {
        result.push(simplified);
        continue;
      }
    }

    if (inst.kind === TACInstructionKind.UnaryOp) {
      const simplified = trySimplifyUnaryOp(inst as UnaryOpInstruction);
      if (simplified) {
        result.push(simplified);
        continue;
      }
    }

    if (inst.kind === TACInstructionKind.Cast) {
      const simplified = trySimplifyCast(inst as CastInstruction);
      if (simplified) {
        result.push(simplified);
        continue;
      }
    }

    result.push(inst);
  }

  return result;
};

export const trySimplifyBinaryOp = (
  inst: BinaryOpInstruction,
): TACInstruction | null => {
  const left = inst.left;
  const right = inst.right;
  const destUdonType = getOperandType(inst.dest).udonType;
  const leftKey = operandKey(left);
  const rightKey = operandKey(right);

  if (inst.operator === "+") {
    if (isZeroConstant(right)) {
      return new AssignmentInstruction(inst.dest, left);
    }
    if (isZeroConstant(left)) {
      return new AssignmentInstruction(inst.dest, right);
    }
  }

  if (inst.operator === "-") {
    if (isZeroConstant(right)) {
      return new AssignmentInstruction(inst.dest, left);
    }
    if (leftKey === rightKey && isIntegerType(destUdonType)) {
      return new AssignmentInstruction(
        inst.dest,
        createConstant(0, getOperandType(inst.dest)),
      );
    }
  }

  if (inst.operator === "*") {
    if (isOneConstant(right)) {
      return new AssignmentInstruction(inst.dest, left);
    }
    if (isOneConstant(left)) {
      return new AssignmentInstruction(inst.dest, right);
    }
    if (
      (isZeroConstant(right) || isZeroConstant(left)) &&
      !isFloatingPointType(destUdonType)
    ) {
      return new AssignmentInstruction(
        inst.dest,
        createConstant(0, getOperandType(inst.dest)),
      );
    }
    // Strength reduction: x * 2^n → x << n (for integer types)
    if (isIntegerType(destUdonType)) {
      const powerRight = getPowerOfTwoValue(right);
      if (powerRight !== null && powerRight > 1) {
        const shiftAmount = Math.log2(powerRight);
        return new BinaryOpInstruction(
          inst.dest,
          left,
          "<<",
          createConstant(shiftAmount, PrimitiveTypes.int32),
        );
      }
      const powerLeft = getPowerOfTwoValue(left);
      if (powerLeft !== null && powerLeft > 1) {
        const shiftAmount = Math.log2(powerLeft);
        return new BinaryOpInstruction(
          inst.dest,
          right,
          "<<",
          createConstant(shiftAmount, PrimitiveTypes.int32),
        );
      }
    }
  }

  if (inst.operator === "/") {
    if (isOneConstant(right)) {
      return new AssignmentInstruction(inst.dest, left);
    }
    const powerOfTwo = getPowerOfTwoValue(right);
    if (powerOfTwo !== null && isUnsignedIntegerType(destUdonType)) {
      const shiftAmount = Math.log2(powerOfTwo);
      return new BinaryOpInstruction(
        inst.dest,
        left,
        ">>",
        createConstant(shiftAmount, PrimitiveTypes.int32),
      );
    }
  }

  if (inst.operator === "%") {
    const powerOfTwo = getPowerOfTwoValue(right);
    if (powerOfTwo !== null && isUnsignedIntegerType(destUdonType)) {
      const mask = powerOfTwo - 1;
      return new BinaryOpInstruction(
        inst.dest,
        left,
        "&",
        createConstant(mask, getOperandType(inst.dest)),
      );
    }
  }

  if (inst.operator === "&" && isIntegerType(destUdonType)) {
    if (isZeroConstant(right) || isZeroConstant(left)) {
      return new AssignmentInstruction(
        inst.dest,
        createConstant(0, getOperandType(inst.dest)),
      );
    }
    if (leftKey === rightKey) {
      return new AssignmentInstruction(inst.dest, left);
    }
  }

  if (inst.operator === "|" && isIntegerType(destUdonType)) {
    if (isZeroConstant(right)) {
      return new AssignmentInstruction(inst.dest, left);
    }
    if (isZeroConstant(left)) {
      return new AssignmentInstruction(inst.dest, right);
    }
    if (leftKey === rightKey) {
      return new AssignmentInstruction(inst.dest, left);
    }
  }

  if (inst.operator === "^" && isIntegerType(destUdonType)) {
    if (isZeroConstant(right)) {
      return new AssignmentInstruction(inst.dest, left);
    }
    if (isZeroConstant(left)) {
      return new AssignmentInstruction(inst.dest, right);
    }
    if (leftKey === rightKey) {
      return new AssignmentInstruction(
        inst.dest,
        createConstant(0, getOperandType(inst.dest)),
      );
    }
  }

  if (
    (inst.operator === "<<" || inst.operator === ">>") &&
    isIntegerType(destUdonType)
  ) {
    if (isZeroConstant(right)) {
      return new AssignmentInstruction(inst.dest, left);
    }
  }

  if (inst.operator === "&&" || inst.operator === "||") {
    if (leftKey === rightKey) {
      return new AssignmentInstruction(inst.dest, left);
    }
  }

  if (inst.operator === "==" && leftKey === rightKey) {
    const leftType = getOperandType(left).udonType;
    if (isIntegerType(leftType)) {
      return new AssignmentInstruction(
        inst.dest,
        createConstant(true, PrimitiveTypes.boolean),
      );
    }
  }

  if (inst.operator === "!=" && leftKey === rightKey) {
    const leftType = getOperandType(left).udonType;
    if (isIntegerType(leftType)) {
      return new AssignmentInstruction(
        inst.dest,
        createConstant(false, PrimitiveTypes.boolean),
      );
    }
  }

  return null;
};

export const trySimplifyUnaryOp = (
  inst: UnaryOpInstruction,
): TACInstruction | null => {
  if (inst.operator === "+") {
    return new AssignmentInstruction(inst.dest, inst.operand);
  }
  return null;
};

export const trySimplifyCast = (
  inst: CastInstruction,
): TACInstruction | null => {
  const srcType = getOperandType(inst.src).udonType;
  const destType = getOperandType(inst.dest).udonType;
  if (srcType === destType) {
    return new AssignmentInstruction(inst.dest, inst.src);
  }
  return null;
};

export const isZeroConstant = (operand: TACOperand): boolean => {
  return (
    operand.kind === TACOperandKind.Constant &&
    typeof (operand as ConstantOperand).value === "number" &&
    (operand as ConstantOperand).value === 0
  );
};

export const isOneConstant = (operand: TACOperand): boolean => {
  return (
    operand.kind === TACOperandKind.Constant &&
    typeof (operand as ConstantOperand).value === "number" &&
    (operand as ConstantOperand).value === 1
  );
};

const getPowerOfTwoValue = (operand: TACOperand): number | null => {
  if (operand.kind !== TACOperandKind.Constant) return null;
  const value = (operand as ConstantOperand).value;
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (!Number.isSafeInteger(value)) return null;
  if (value <= 0) return null;
  const exponent = Math.log2(value);
  if (!Number.isInteger(exponent)) return null;
  return value;
};

const isFloatingPointType = (udonType: UdonType): boolean => {
  return udonType === UdonType.Single || udonType === UdonType.Double;
};

const isIntegerType = (udonType: UdonType): boolean => {
  return isIntegerUdonType(udonType);
};

const isUnsignedIntegerType = (udonType: UdonType): boolean => {
  return (
    udonType === UdonType.Byte ||
    udonType === UdonType.UInt16 ||
    udonType === UdonType.UInt32 ||
    udonType === UdonType.UInt64
  );
};

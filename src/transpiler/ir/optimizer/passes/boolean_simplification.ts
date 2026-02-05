import { PrimitiveTypes } from "../../../frontend/type_symbols.js";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnaryOpInstruction,
} from "../../tac_instruction.js";
import type {
  ConstantOperand,
  ConstantValue,
  TACOperand,
} from "../../tac_operand.js";
import { TACOperandKind, createConstant } from "../../tac_operand.js";
import { getOperandType } from "./constant_folding.js";

export const booleanSimplification = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const result: TACInstruction[] = [];

  for (const inst of instructions) {
    if (inst.kind !== TACInstructionKind.BinaryOp) {
      result.push(inst);
      continue;
    }

    const bin = inst as BinaryOpInstruction;
    const destType = getOperandType(bin.dest);
    if (destType.udonType !== PrimitiveTypes.boolean.udonType) {
      result.push(inst);
      continue;
    }

    const leftConst = getBooleanConstant(bin.left);
    const rightConst = getBooleanConstant(bin.right);

    if (bin.operator === "&&") {
      if (leftConst !== null) {
        if (!leftConst) {
          result.push(
            new AssignmentInstruction(
              bin.dest,
              createConstant(false, destType),
            ),
          );
        } else {
          result.push(new AssignmentInstruction(bin.dest, bin.right));
        }
        continue;
      }
      if (rightConst !== null) {
        if (!rightConst) {
          result.push(
            new AssignmentInstruction(
              bin.dest,
              createConstant(false, destType),
            ),
          );
        } else {
          result.push(new AssignmentInstruction(bin.dest, bin.left));
        }
        continue;
      }
    }

    if (bin.operator === "||") {
      if (leftConst !== null) {
        if (leftConst) {
          result.push(
            new AssignmentInstruction(
              bin.dest,
              createConstant(true, destType),
            ),
          );
        } else {
          result.push(new AssignmentInstruction(bin.dest, bin.right));
        }
        continue;
      }
      if (rightConst !== null) {
        if (rightConst) {
          result.push(
            new AssignmentInstruction(
              bin.dest,
              createConstant(true, destType),
            ),
          );
        } else {
          result.push(new AssignmentInstruction(bin.dest, bin.left));
        }
        continue;
      }
    }

    if (bin.operator === "==" || bin.operator === "!=") {
      const constantSide =
        rightConst !== null
          ? { constant: rightConst, operand: bin.left }
          : leftConst !== null
            ? { constant: leftConst, operand: bin.right }
            : null;
      if (constantSide) {
        const { constant, operand } = constantSide;
        const shouldNegate =
          (bin.operator === "==" && !constant) ||
          (bin.operator === "!=" && constant);
        if (shouldNegate) {
          result.push(new UnaryOpInstruction(bin.dest, "!", operand));
        } else {
          result.push(new AssignmentInstruction(bin.dest, operand));
        }
        continue;
      }
    }

    result.push(inst);
  }

  return result;
};

export const isTruthyConstant = (value: ConstantValue): boolean | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return false;
    return value !== 0;
  }
  return null;
};

export const getBooleanConstant = (operand: TACOperand): boolean | null => {
  if (operand.kind !== TACOperandKind.Constant) return null;
  const constOp = operand as ConstantOperand;
  if (typeof constOp.value !== "boolean") return null;
  return constOp.value;
};

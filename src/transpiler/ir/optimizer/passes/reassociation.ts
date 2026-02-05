import type { TACInstruction } from "../../tac_instruction.js";
import {
  BinaryOpInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import type { ConstantOperand, TACOperand } from "../../tac_operand.js";
import { createConstant, TACOperandKind } from "../../tac_operand.js";
import { operandKey } from "../utils/operands.js";
import {
  evaluateBinaryOp,
  getOperandType,
  isNumericUdonType,
} from "./constant_folding.js";

type ConstAndNonConst = {
  constant: ConstantOperand;
  nonConstant: TACOperand;
  constantOnLeft: boolean;
};

type ReassociationResult = {
  operator: string;
  constantValue: number;
  nonConstant: TACOperand;
};

export const reassociate = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const result: TACInstruction[] = [];
  const definitions = new Map<string, BinaryOpInstruction>();

  const resetDefinitions = (): void => {
    definitions.clear();
  };

  for (const inst of instructions) {
    if (inst.kind === TACInstructionKind.Label) {
      resetDefinitions();
      result.push(inst);
      continue;
    }

    let updated = inst;
    if (inst.kind === TACInstructionKind.BinaryOp) {
      const outer = inst as BinaryOpInstruction;
      const outerType = getOperandType(outer.dest).udonType;
      if (isNumericUdonType(outerType)) {
        const leftKey = operandKey(outer.left);
        const rightKey = operandKey(outer.right);
        const leftDef = definitions.get(leftKey);
        const rightDef = definitions.get(rightKey);

        const fromLeft = leftDef ? tryReassociate(outer, leftDef, true) : null;
        const fromRight =
          !fromLeft && rightDef ? tryReassociate(outer, rightDef, false) : null;
        if (fromLeft || fromRight) {
          const chosen = fromLeft ?? (fromRight as ReassociationResult);
          const constantOperand = createConstant(
            chosen.constantValue,
            getOperandType(outer.dest),
          );
          updated = new BinaryOpInstruction(
            outer.dest,
            chosen.nonConstant,
            chosen.operator,
            constantOperand,
          );
        }
      }
    }

    result.push(updated);

    if (updated.kind === TACInstructionKind.BinaryOp) {
      const bin = updated as BinaryOpInstruction;
      definitions.set(operandKey(bin.dest), bin);
    }
  }

  return result;
};

const tryReassociate = (
  outer: BinaryOpInstruction,
  inner: BinaryOpInstruction,
  outerUsesLeft: boolean,
): ReassociationResult | null => {
  const outerType = getOperandType(outer.dest).udonType;
  const innerType = getOperandType(inner.dest).udonType;
  if (outerType !== innerType || !isNumericUdonType(outerType)) {
    return null;
  }
  if (outer.operator === "-" && !outerUsesLeft) {
    return null;
  }

  const outerOther = outerUsesLeft ? outer.right : outer.left;
  const outerConst = extractNumericConstant(outerOther);
  if (!outerConst) return null;

  const innerParts = extractConstAndNonConst(inner);
  if (!innerParts) return null;
  if (inner.operator === "-" && innerParts.constantOnLeft) {
    return null;
  }

  const c1 = innerParts.constant.value as number;
  const c2 = outerConst.value as number;

  const combined = combineConstants(
    inner.operator,
    outer.operator,
    c1,
    c2,
    innerParts.nonConstant,
  );
  if (!combined) return null;
  if (!Number.isFinite(combined.constantValue)) return null;

  return combined;
};

const extractConstAndNonConst = (
  inst: BinaryOpInstruction,
): ConstAndNonConst | null => {
  const leftConst = extractNumericConstant(inst.left);
  const rightConst = extractNumericConstant(inst.right);
  if (leftConst && !rightConst) {
    return {
      constant: leftConst,
      nonConstant: inst.right,
      constantOnLeft: true,
    };
  }
  if (rightConst && !leftConst) {
    return {
      constant: rightConst,
      nonConstant: inst.left,
      constantOnLeft: false,
    };
  }
  return null;
};

const extractNumericConstant = (
  operand: TACOperand,
): ConstantOperand | null => {
  if (operand.kind !== TACOperandKind.Constant) return null;
  const constant = operand as ConstantOperand;
  if (typeof constant.value !== "number") return null;
  if (!Number.isFinite(constant.value)) return null;
  return constant;
};

const combineConstants = (
  innerOp: string,
  outerOp: string,
  c1: number,
  c2: number,
  nonConstant: TACOperand,
): ReassociationResult | null => {
  if (innerOp === "+" && outerOp === "+") {
    const value = evaluateBinaryOp(c1, "+", c2);
    if (typeof value !== "number") return null;
    return { operator: "+", constantValue: value, nonConstant };
  }

  if (innerOp === "+" && outerOp === "-") {
    const value = evaluateBinaryOp(c1, "-", c2);
    if (typeof value !== "number") return null;
    return { operator: "+", constantValue: value, nonConstant };
  }

  if (innerOp === "-" && outerOp === "-") {
    const value = evaluateBinaryOp(c1, "+", c2);
    if (typeof value !== "number") return null;
    return { operator: "-", constantValue: value, nonConstant };
  }

  if (innerOp === "-" && outerOp === "+") {
    const value = evaluateBinaryOp(c1, "-", c2);
    if (typeof value !== "number") return null;
    if (value >= 0) {
      return { operator: "-", constantValue: value, nonConstant };
    }
    return { operator: "+", constantValue: Math.abs(value), nonConstant };
  }

  if (innerOp === "*" && outerOp === "*") {
    const value = evaluateBinaryOp(c1, "*", c2);
    if (typeof value !== "number") return null;
    return { operator: "*", constantValue: value, nonConstant };
  }

  return null;
};

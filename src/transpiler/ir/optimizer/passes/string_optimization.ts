import { PrimitiveTypes } from "../../../frontend/type_symbols.js";
import {
  type BinaryOpInstruction,
  CallInstruction,
  type TACInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import type { TACOperand, TemporaryOperand } from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";
import { countTempUses } from "../utils/instructions.js";
import { getOperandType } from "./constant_folding.js";

const CONCAT_EXTERN =
  "SystemString.__Concat__SystemString_SystemString__SystemString";

const isStringOperand = (operand: TACOperand): boolean => {
  return getOperandType(operand).udonType === PrimitiveTypes.string.udonType;
};

const isTemp = (operand: TACOperand): operand is TemporaryOperand => {
  return operand.kind === TACOperandKind.Temporary;
};

export const optimizeStringConcatenation = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  if (instructions.length === 0) return instructions;

  const tempUses = countTempUses(instructions);
  const result: TACInstruction[] = [];

  let i = 0;
  while (i < instructions.length) {
    const inst = instructions[i];
    if (inst.kind !== TACInstructionKind.BinaryOp) {
      result.push(inst);
      i += 1;
      continue;
    }

    const bin = inst as BinaryOpInstruction;
    if (bin.operator !== "+") {
      result.push(inst);
      i += 1;
      continue;
    }

    if (!isStringOperand(bin.dest)) {
      result.push(inst);
      i += 1;
      continue;
    }

    if (!isStringOperand(bin.left) || !isStringOperand(bin.right)) {
      result.push(inst);
      i += 1;
      continue;
    }

    const operands: TACOperand[] = [bin.left, bin.right];
    const dests: TACOperand[] = [bin.dest];
    let currentDest: TACOperand = bin.dest;
    let chainLength = 1;
    let cursor = i;

    while (
      isTemp(currentDest) &&
      (tempUses.get(currentDest.id) ?? 0) === 1 &&
      cursor + 1 < instructions.length
    ) {
      const nextInst = instructions[cursor + 1];
      if (nextInst.kind !== TACInstructionKind.BinaryOp) break;
      const nextBin = nextInst as BinaryOpInstruction;
      if (nextBin.operator !== "+") break;
      if (!isStringOperand(nextBin.dest)) break;
      if (!isStringOperand(nextBin.left) || !isStringOperand(nextBin.right)) {
        break;
      }
      if (nextBin.left.kind !== TACOperandKind.Temporary) break;
      if ((nextBin.left as TemporaryOperand).id !== currentDest.id) break;

      operands.push(nextBin.right);
      currentDest = nextBin.dest;
      dests.push(currentDest);
      chainLength += 1;
      cursor += 1;
    }

    if (chainLength < 2 || !isTemp(currentDest)) {
      result.push(inst);
      i += 1;
      continue;
    }

    result.push(
      new CallInstruction(dests[0], CONCAT_EXTERN, [
        operands[0],
        operands[1],
      ]),
    );
    for (let idx = 2; idx < operands.length; idx += 1) {
      result.push(
        new CallInstruction(dests[idx - 1], CONCAT_EXTERN, [
          dests[idx - 2],
          operands[idx],
        ]),
      );
    }

    i = cursor + 1;
  }

  return result;
};

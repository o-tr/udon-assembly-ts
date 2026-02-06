import {
  type LabelInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import type { LabelOperand } from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";

export const eliminateFallthroughJumps = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  if (instructions.length === 0) return instructions;

  const result: TACInstruction[] = [];
  for (let i = 0; i < instructions.length; i += 1) {
    const inst = instructions[i];
    if (inst.kind !== TACInstructionKind.UnconditionalJump) {
      result.push(inst);
      continue;
    }

    const jump = inst as UnconditionalJumpInstruction;
    if (jump.label.kind !== TACOperandKind.Label) {
      result.push(inst);
      continue;
    }

    const next = instructions[i + 1];
    if (!next || next.kind !== TACInstructionKind.Label) {
      result.push(inst);
      continue;
    }

    const labelInst = next as LabelInstruction;
    if (labelInst.label.kind !== TACOperandKind.Label) {
      result.push(inst);
      continue;
    }

    const targetName = (jump.label as LabelOperand).name;
    const labelName = (labelInst.label as LabelOperand).name;
    if (targetName === labelName) {
      continue;
    }

    result.push(inst);
  }

  return result;
};

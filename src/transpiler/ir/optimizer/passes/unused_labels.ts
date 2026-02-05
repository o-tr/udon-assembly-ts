import type { TACInstruction } from "../../tac_instruction.js";
import {
  type ConditionalJumpInstruction,
  type LabelInstruction,
  TACInstructionKind,
  type UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import type { LabelOperand } from "../../tac_operand.js";

export const eliminateUnusedLabels = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const referenced = new Set<string>();
  for (const inst of instructions) {
    if (inst.kind === TACInstructionKind.ConditionalJump) {
      const jump = inst as ConditionalJumpInstruction;
      referenced.add((jump.label as LabelOperand).name);
    }
    if (inst.kind === TACInstructionKind.UnconditionalJump) {
      const jump = inst as UnconditionalJumpInstruction;
      referenced.add((jump.label as LabelOperand).name);
    }
  }

  return instructions.filter((inst) => {
    if (inst.kind !== TACInstructionKind.Label) return true;
    const label = inst as LabelInstruction;
    return referenced.has((label.label as LabelOperand).name);
  });
};

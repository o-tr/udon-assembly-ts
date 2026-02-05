import type {
  ConditionalJumpInstruction,
  LabelInstruction,
  TACInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import { TACInstructionKind } from "../../tac_instruction.js";
import type { LabelOperand } from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";

export type BasicBlock = {
  id: number;
  start: number;
  end: number;
  preds: number[];
  succs: number[];
};

export const isBlockTerminator = (inst: TACInstruction): boolean => {
  return (
    inst.kind === TACInstructionKind.UnconditionalJump ||
    inst.kind === TACInstructionKind.ConditionalJump ||
    inst.kind === TACInstructionKind.Return
  );
};

export const buildCFG = (
  instructions: TACInstruction[],
): { blocks: BasicBlock[] } => {
  if (instructions.length === 0) {
    return { blocks: [] };
  }

  const leaders = new Set<number>();
  leaders.add(0);

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    if (inst.kind === TACInstructionKind.Label) {
      leaders.add(i);
    }
    if (isBlockTerminator(inst) && i + 1 < instructions.length) {
      leaders.add(i + 1);
    }
  }

  const sortedLeaders = Array.from(leaders).sort((a, b) => a - b);
  const blocks: BasicBlock[] = [];
  for (let i = 0; i < sortedLeaders.length; i++) {
    const start = sortedLeaders[i];
    const end =
      i + 1 < sortedLeaders.length
        ? sortedLeaders[i + 1] - 1
        : instructions.length - 1;
    blocks.push({ id: i, start, end, preds: [], succs: [] });
  }

  const labelToBlock = new Map<string, number>();
  for (const block of blocks) {
    for (let i = block.start; i <= block.end; i++) {
      const inst = instructions[i];
      if (inst.kind === TACInstructionKind.Label) {
        const labelInst = inst as LabelInstruction;
        if (labelInst.label.kind === TACOperandKind.Label) {
          const label = labelInst.label as LabelOperand;
          labelToBlock.set(label.name, block.id);
        }
      }
    }
  }

  for (const block of blocks) {
    const lastInst = instructions[block.end];
    if (lastInst.kind === TACInstructionKind.UnconditionalJump) {
      const label = (lastInst as UnconditionalJumpInstruction).label as {
        name?: string;
      };
      const target = label?.name ? labelToBlock.get(label.name) : undefined;
      if (target !== undefined) {
        block.succs.push(target);
      }
    } else if (lastInst.kind === TACInstructionKind.ConditionalJump) {
      const label = (lastInst as ConditionalJumpInstruction).label as {
        name?: string;
      };
      const target = label?.name ? labelToBlock.get(label.name) : undefined;
      if (target !== undefined) {
        block.succs.push(target);
      }
      const fallthrough = block.id + 1;
      if (fallthrough < blocks.length) {
        block.succs.push(fallthrough);
      }
    } else if (lastInst.kind !== TACInstructionKind.Return) {
      const fallthrough = block.id + 1;
      if (fallthrough < blocks.length) {
        block.succs.push(fallthrough);
      }
    }
  }

  for (const block of blocks) {
    for (const succ of block.succs) {
      blocks[succ].preds.push(block.id);
    }
  }

  return { blocks };
};

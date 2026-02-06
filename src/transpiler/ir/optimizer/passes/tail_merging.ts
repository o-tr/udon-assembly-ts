import {
  LabelInstruction,
  type ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import { createLabel, TACOperandKind } from "../../tac_operand.js";
import { operandKey } from "../utils/operands.js";

type ReturnInfo = {
  index: number;
  key: string;
};

const collectReturns = (instructions: TACInstruction[]): ReturnInfo[] => {
  const returns: ReturnInfo[] = [];
  for (let i = 0; i < instructions.length; i += 1) {
    const inst = instructions[i];
    if (inst.kind !== TACInstructionKind.Return) continue;
    const ret = inst as ReturnInstruction;
    const key = ret.value ? operandKey(ret.value) : "<void>";
    returns.push({ index: i, key });
  }
  return returns;
};

export const mergeTails = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  if (instructions.length === 0) return instructions;

  const returns = collectReturns(instructions);
  if (returns.length < 2) return instructions;

  const groups = new Map<string, ReturnInfo[]>();
  for (const info of returns) {
    const group = groups.get(info.key) ?? [];
    group.push(info);
    groups.set(info.key, group);
  }

  let labelCounter = 0;
  const insertLabels = new Map<number, string>();
  const replaceWithJump = new Map<number, string>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const canonical = group[0];
    const labelName = `tail_merge_${labelCounter++}`;
    insertLabels.set(canonical.index, labelName);
    for (let i = 1; i < group.length; i += 1) {
      replaceWithJump.set(group[i].index, labelName);
    }
  }

  if (insertLabels.size === 0 && replaceWithJump.size === 0) {
    return instructions;
  }

  const result: TACInstruction[] = [];
  for (let i = 0; i < instructions.length; i += 1) {
    const labelName = insertLabels.get(i);
    if (labelName) {
      result.push(new LabelInstruction(createLabel(labelName)));
    }

    const jumpLabel = replaceWithJump.get(i);
    if (jumpLabel) {
      const label = createLabel(jumpLabel);
      if (label.kind === TACOperandKind.Label) {
        result.push(new UnconditionalJumpInstruction(label));
      }
      continue;
    }

    result.push(instructions[i]);
  }

  return result;
};

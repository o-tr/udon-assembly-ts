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
  tailSig: string | null;
};

const findTailStart = (
  instructions: TACInstruction[],
  index: number,
): number => {
  for (let i = index; i >= 0; i -= 1) {
    if (instructions[i].kind === TACInstructionKind.Label) return i;
  }
  return 0;
};

const isStraightLineTail = (
  instructions: TACInstruction[],
  start: number,
  end: number,
): boolean => {
  for (let i = start; i < end; i += 1) {
    const inst = instructions[i];
    if (
      inst.kind === TACInstructionKind.ConditionalJump ||
      inst.kind === TACInstructionKind.UnconditionalJump ||
      inst.kind === TACInstructionKind.Return
    ) {
      return false;
    }
  }
  return true;
};

const buildTailSignature = (
  instructions: TACInstruction[],
  index: number,
): string | null => {
  const start = findTailStart(instructions, index);
  if (!isStraightLineTail(instructions, start, index)) return null;
  const slice = instructions.slice(start, index + 1);
  // strip leading labels for canonicalization
  let s = 0;
  while (s < slice.length && slice[s].kind === TACInstructionKind.Label) s++;
  const canonical = slice.slice(s);
  return canonical.map((inst) => inst.toString()).join("|");
};

const collectReturns = (instructions: TACInstruction[]): ReturnInfo[] => {
  const returns: ReturnInfo[] = [];
  for (let i = 0; i < instructions.length; i += 1) {
    const inst = instructions[i];
    if (inst.kind !== TACInstructionKind.Return) continue;
    const ret = inst as ReturnInstruction;
    const key = ret.value ? operandKey(ret.value) : "<void>";
    const tailSig = buildTailSignature(instructions, i);
    returns.push({ index: i, key, tailSig });
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
    if (!info.tailSig) continue;
    const groupKey = `${info.key}|${info.tailSig}`;
    const group = groups.get(groupKey) ?? [];
    group.push(info);
    groups.set(groupKey, group);
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

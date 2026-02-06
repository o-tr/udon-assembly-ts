import {
  type AssignmentInstruction,
  type BinaryOpInstruction,
  type CopyInstruction,
  LabelInstruction,
  type PropertyGetInstruction,
  type PropertySetInstruction,
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
  for (let i = index - 1; i >= 0; i -= 1) {
    const k = instructions[i].kind;
    if (k === TACInstructionKind.Label) return i;
    // stop at control-flow boundaries: conditional/unconditional jumps or returns
    if (
      k === TACInstructionKind.ConditionalJump ||
      k === TACInstructionKind.UnconditionalJump ||
      k === TACInstructionKind.Return
    ) {
      return i + 1;
    }
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

const instSignature = (inst: TACInstruction): string => {
  switch (inst.kind) {
    case TACInstructionKind.BinaryOp: {
      const b = inst as BinaryOpInstruction;
      return `BinaryOp|${b.operator}|${operandKey(b.left)}|${operandKey(b.right)}|${operandKey(b.dest)}`;
    }
    case TACInstructionKind.Assignment: {
      const a = inst as AssignmentInstruction;
      return `${inst.kind}|${operandKey(a.dest)}|${operandKey((a as AssignmentInstruction).src)}`;
    }
    case TACInstructionKind.Copy: {
      const c = inst as CopyInstruction;
      return `${inst.kind}|${operandKey(c.dest)}|${operandKey(c.src)}`;
    }
    case TACInstructionKind.PropertySet: {
      const p = inst as PropertySetInstruction;
      return `PropertySet|${operandKey(p.object)}|${p.property}|${operandKey(p.value)}`;
    }
    case TACInstructionKind.PropertyGet: {
      const p = inst as PropertyGetInstruction;
      return `PropertyGet|${operandKey(p.dest)}|${operandKey(p.object)}|${p.property}`;
    }
    case TACInstructionKind.Label:
      return `Label`;
    case TACInstructionKind.Return: {
      const r = inst as ReturnInstruction;
      return `Return|${r.value ? operandKey(r.value) : "<void>"}`;
    }
    default:
      return `${inst.kind}|${inst.toString()}`;
  }
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
  return canonical.map((inst) => instSignature(inst)).join("|");
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
  const replaceWithJump = new Map<number, { label: string; end: number }>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const canonical = group[0];
    const labelName = `tail_merge_${labelCounter++}`;
    const canonicalStart = findTailStart(instructions, canonical.index);
    insertLabels.set(canonicalStart, labelName);
    for (let i = 1; i < group.length; i += 1) {
      const nonCanonical = group[i];
      const nonStart = findTailStart(instructions, nonCanonical.index);
      replaceWithJump.set(nonStart, {
        label: labelName,
        end: nonCanonical.index,
      });
    }
  }

  if (insertLabels.size === 0 && replaceWithJump.size === 0) {
    return instructions;
  }

  const result: TACInstruction[] = [];
  let i = 0;
  while (i < instructions.length) {
    const labelName = insertLabels.get(i);
    if (labelName) {
      result.push(new LabelInstruction(createLabel(labelName)));
    }

    const rep = replaceWithJump.get(i);
    if (rep) {
      const label = createLabel(rep.label);
      if (label.kind === TACOperandKind.Label) {
        result.push(new UnconditionalJumpInstruction(label));
      }
      i = rep.end + 1;
      continue;
    }

    result.push(instructions[i]);
    i += 1;
  }

  return result;
};

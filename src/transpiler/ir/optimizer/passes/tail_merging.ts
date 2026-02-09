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
import {
  createLabel,
  type LabelOperand,
  TACOperandKind,
} from "../../tac_operand.js";
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
    if (
      inst.kind === TACInstructionKind.Call ||
      inst.kind === TACInstructionKind.MethodCall ||
      inst.kind === TACInstructionKind.PropertySet ||
      inst.kind === TACInstructionKind.ArrayAssignment
    ) {
      return false;
    }
  }
  return true;
};

const instSignature = (inst: TACInstruction): string | null => {
  switch (inst.kind) {
    case TACInstructionKind.BinaryOp: {
      const b = inst as BinaryOpInstruction;
      return `BinaryOp|${operandKey(b.dest)}|${b.operator}|${operandKey(b.left)}|${operandKey(b.right)}`;
    }
    case TACInstructionKind.Assignment: {
      const a = inst as AssignmentInstruction;
      return `Assignment|${operandKey(a.dest)}|${operandKey(a.src)}`;
    }
    case TACInstructionKind.Copy: {
      const c = inst as CopyInstruction;
      return `Copy|${operandKey(c.dest)}|${operandKey(c.src)}`;
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
    case TACInstructionKind.UnconditionalJump: {
      const j = inst as UnconditionalJumpInstruction;
      if (j.label.kind === TACOperandKind.Label) {
        return `Jump|${(j.label as LabelOperand).name}`;
      }
      return null;
    }
    default:
      return null;
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
  const parts: string[] = [];
  for (const inst of canonical) {
    const sig = instSignature(inst);
    if (!sig) return null;
    parts.push(sig);
  }
  return parts.join("|");
};

const collectTailEndpoints = (
  instructions: TACInstruction[],
  labelDefCount: Map<string, number>,
): ReturnInfo[] => {
  const endpoints: ReturnInfo[] = [];
  for (let i = 0; i < instructions.length; i += 1) {
    const inst = instructions[i];
    if (inst.kind === TACInstructionKind.Return) {
      const ret = inst as ReturnInstruction;
      const key = `ret|${ret.value ? operandKey(ret.value) : "<void>"}`;
      const tailSig = buildTailSignature(instructions, i);
      endpoints.push({ index: i, key, tailSig });
    }
    if (inst.kind === TACInstructionKind.UnconditionalJump) {
      const jump = inst as UnconditionalJumpInstruction;
      if (jump.label.kind !== TACOperandKind.Label) continue;
      const targetName = (jump.label as LabelOperand).name;
      // Skip jumps to multiply-defined labels to avoid mismerging
      if ((labelDefCount.get(targetName) ?? 0) !== 1) continue;
      const key = `jump|${targetName}`;
      const tailSig = buildTailSignature(instructions, i);
      endpoints.push({ index: i, key, tailSig });
    }
  }
  return endpoints;
};

export const mergeTails = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  if (instructions.length === 0) return instructions;

  // Count label definitions to ensure uniqueness for jump targets
  const labelDefCount = new Map<string, number>();
  for (const inst of instructions) {
    if (inst.kind === TACInstructionKind.Label) {
      const labelInst = inst as LabelInstruction;
      if (labelInst.label.kind === TACOperandKind.Label) {
        const name = (labelInst.label as LabelOperand).name;
        labelDefCount.set(name, (labelDefCount.get(name) ?? 0) + 1);
      }
    }
  }

  const endpoints = collectTailEndpoints(instructions, labelDefCount);
  if (endpoints.length < 2) return instructions;

  const groups = new Map<string, ReturnInfo[]>();
  for (const info of endpoints) {
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
      let nonStart = findTailStart(instructions, nonCanonical.index);
      while (
        nonStart < nonCanonical.index &&
        instructions[nonStart].kind === TACInstructionKind.Label
      ) {
        nonStart += 1;
      }
      let hasInteriorLabel = false;
      for (let j = nonStart; j < nonCanonical.index; j += 1) {
        if (instructions[j].kind === TACInstructionKind.Label) {
          hasInteriorLabel = true;
          break;
        }
      }
      if (hasInteriorLabel) continue;
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
  for (let i = 0; i < instructions.length; i += 1) {
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
      i = rep.end;
      continue;
    }

    result.push(instructions[i]);
  }

  return result;
};

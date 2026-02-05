import {
  ConditionalJumpInstruction,
  LabelInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  createLabel,
  type LabelOperand,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import type { BasicBlock } from "../analysis/cfg.js";
import { isTruthyConstant } from "./boolean_simplification.js";
import type { ConstantOperand } from "../../tac_operand.js";

export const simplifyJumps = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  if (instructions.length === 0) return instructions;

  const labelAlias = new Map<string, string>();
  for (let i = 0; i < instructions.length; i += 1) {
    const inst = instructions[i];
    if (inst.kind !== TACInstructionKind.Label) continue;
    const names: string[] = [];
    let j = i;
    while (
      j < instructions.length &&
      instructions[j].kind === TACInstructionKind.Label
    ) {
      const labelInst = instructions[j] as LabelInstruction;
      if (labelInst.label.kind === TACOperandKind.Label) {
        names.push((labelInst.label as LabelOperand).name);
      }
      j += 1;
    }
    if (names.length > 0) {
      const canonical = names[names.length - 1];
      for (const name of names) {
        labelAlias.set(name, canonical);
      }
    }
    i = j - 1;
  }

  const canonicalLabel = (name: string): string => labelAlias.get(name) ?? name;

  const labelIndex = new Map<string, number>();
  for (let i = 0; i < instructions.length; i += 1) {
    const inst = instructions[i];
    if (inst.kind !== TACInstructionKind.Label) continue;
    const labelInst = inst as LabelInstruction;
    if (labelInst.label.kind !== TACOperandKind.Label) continue;
    const name = canonicalLabel((labelInst.label as LabelOperand).name);
    labelIndex.set(name, i);
  }

  const resolveLabelName = (name: string): string => {
    let current = canonicalLabel(name);
    const seen = new Set<string>();

    while (!seen.has(current)) {
      seen.add(current);
      const index = labelIndex.get(current);
      if (index === undefined) break;

      let nextIndex = index + 1;
      while (
        nextIndex < instructions.length &&
        instructions[nextIndex].kind === TACInstructionKind.Label
      ) {
        nextIndex += 1;
      }

      if (nextIndex >= instructions.length) break;
      const nextInst = instructions[nextIndex];
      if (nextInst.kind !== TACInstructionKind.UnconditionalJump) break;

      const target = (nextInst as UnconditionalJumpInstruction).label;
      if (target.kind !== TACOperandKind.Label) break;

      current = canonicalLabel((target as LabelOperand).name);
    }

    return current;
  };

  const resolved = new Map<string, string>();
  for (const name of labelIndex.keys()) {
    resolved.set(name, resolveLabelName(name));
  }

  const isJumpToNextLabel = (index: number, targetName: string): boolean => {
    for (let i = index + 1; i < instructions.length; i += 1) {
      const inst = instructions[i];
      if (inst.kind !== TACInstructionKind.Label) return false;
      const labelInst = inst as LabelInstruction;
      if (labelInst.label.kind !== TACOperandKind.Label) continue;
      const name = canonicalLabel((labelInst.label as LabelOperand).name);
      if (name === targetName) return true;
    }
    return false;
  };

  const result: TACInstruction[] = [];
  for (let i = 0; i < instructions.length; i += 1) {
    const inst = instructions[i];
    if (inst.kind === TACInstructionKind.Label) {
      const labelInst = inst as LabelInstruction;
      if (labelInst.label.kind === TACOperandKind.Label) {
        const name = (labelInst.label as LabelOperand).name;
        if (canonicalLabel(name) !== name) {
          continue;
        }
      }
    }
    if (
      inst.kind === TACInstructionKind.UnconditionalJump ||
      inst.kind === TACInstructionKind.ConditionalJump
    ) {
      const label = (inst as unknown as { label: TACOperand }).label;
      if (label.kind === TACOperandKind.Label) {
        const labelName = canonicalLabel((label as LabelOperand).name);
        const resolvedName = resolved.get(labelName) ?? labelName;
        if (isJumpToNextLabel(i, resolvedName)) {
          continue;
        }
        if (resolvedName !== labelName) {
          const resolvedLabel = createLabel(resolvedName);
          if (inst.kind === TACInstructionKind.UnconditionalJump) {
            result.push(new UnconditionalJumpInstruction(resolvedLabel));
          } else {
            const cond = (inst as ConditionalJumpInstruction).condition;
            result.push(new ConditionalJumpInstruction(cond, resolvedLabel));
          }
          continue;
        }
      }
    }
    result.push(inst);
  }

  return mergeLinearBlocks(result);
};

export const mergeLinearBlocks = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  let current = instructions;
  while (true) {
    const cfg = buildCFG(current);
    if (cfg.blocks.length === 0) return current;

    const labelToBlock = new Map<string, number>();
    for (const block of cfg.blocks) {
      for (let i = block.start; i <= block.end; i++) {
        const inst = current[i];
        if (inst.kind !== TACInstructionKind.Label) continue;
        const labelInst = inst as LabelInstruction;
        if (labelInst.label.kind !== TACOperandKind.Label) continue;
        labelToBlock.set((labelInst.label as LabelOperand).name, block.id);
      }
    }

    const mergeMap = new Map<number, number>();
    const mergedTargets = new Set<number>();
    for (const block of cfg.blocks) {
      if (mergedTargets.has(block.id)) continue;
      const lastInst = current[block.end];
      if (lastInst?.kind !== TACInstructionKind.UnconditionalJump) continue;
      const targetLabel = (lastInst as UnconditionalJumpInstruction).label;
      if (targetLabel.kind !== TACOperandKind.Label) continue;
      const targetId = labelToBlock.get((targetLabel as LabelOperand).name);
      if (targetId === undefined || targetId === block.id) continue;
      const targetBlock = cfg.blocks[targetId];
      if (targetBlock.preds.length !== 1) continue;
      mergeMap.set(block.id, targetId);
      mergedTargets.add(targetId);
    }

    if (mergeMap.size === 0) return current;

    const result: TACInstruction[] = [];
    for (const block of cfg.blocks) {
      if (mergedTargets.has(block.id)) continue;
      const mergeTarget = mergeMap.get(block.id);
      if (mergeTarget !== undefined) {
        for (let i = block.start; i <= block.end; i++) {
          if (i === block.end) continue; // drop the unconditional jump
          result.push(current[i]);
        }
        const targetBlock = cfg.blocks[mergeTarget];
        let start = targetBlock.start;
        while (
          start <= targetBlock.end &&
          current[start].kind === TACInstructionKind.Label
        ) {
          start += 1;
        }
        for (let i = start; i <= targetBlock.end; i++) {
          result.push(current[i]);
        }
        continue;
      }

      for (let i = block.start; i <= block.end; i++) {
        result.push(current[i]);
      }
    }

    current = result;
  }
};

export const resolveReachableSuccs = (
  block: BasicBlock,
  instructions: TACInstruction[],
  labelToBlock: Map<string, number>,
  resolveConstant: (operand: TACOperand) => ConstantOperand | null,
  blockCount: number,
): number[] => {
  if (block.end < block.start) return [];
  const last = instructions[block.end];
  const fallthrough = block.id + 1 < blockCount ? block.id + 1 : undefined;

  if (last.kind === TACInstructionKind.UnconditionalJump) {
    const label = (last as UnconditionalJumpInstruction).label;
    if (label.kind === TACOperandKind.Label) {
      const target = labelToBlock.get((label as LabelOperand).name);
      return target !== undefined ? [target] : [];
    }
    return [];
  }

  if (last.kind === TACInstructionKind.ConditionalJump) {
    const condInst = last as ConditionalJumpInstruction;
    const conditionConst = resolveConstant(condInst.condition);
    const label = condInst.label;
    const target =
      label.kind === TACOperandKind.Label
        ? labelToBlock.get((label as LabelOperand).name)
        : undefined;
    const truthy = conditionConst ? isTruthyConstant(conditionConst.value) : null;
    if (truthy === true) {
      return fallthrough !== undefined ? [fallthrough] : [];
    }
    if (truthy === false) {
      return target !== undefined ? [target] : [];
    }
    const succs: number[] = [];
    if (target !== undefined) succs.push(target);
    if (fallthrough !== undefined) succs.push(fallthrough);
    return succs;
  }

  if (last.kind === TACInstructionKind.Return) {
    return [];
  }

  return fallthrough !== undefined ? [fallthrough] : [];
};

import type { TACInstruction } from "../../tac_instruction.js";
import {
  AssignmentInstruction,
  type ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  type ReturnInstruction,
  TACInstructionKind,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import type {
  ArrayAccessInstruction,
  ArrayAssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  PropertySetInstruction,
  UnaryOpInstruction,
} from "../../tac_instruction.js";
import type { TACOperand } from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";
import type { TemporaryOperand } from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import { stringSetEqual } from "../utils/sets.js";
import {
  getDefinedOperandForReuse,
  getUsedOperandsForReuse,
  InstWithDestSrc,
  isPureProducer,
} from "../utils/instructions.js";
import { sameOperand } from "../utils/operands.js";
import { livenessKey } from "../utils/liveness.js";

/**
 * Dead code elimination
 * Remove unreachable code after unconditional jumps
 */
export const deadCodeElimination = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const result: TACInstruction[] = [];
  let unreachable = false;

  for (const inst of instructions) {
    // Label marks start of reachable code
    if (inst.kind === TACInstructionKind.Label) {
      unreachable = false;
    }

    // Skip unreachable instructions
    if (unreachable) {
      continue;
    }

    result.push(inst);

    // After unconditional jump, code is unreachable until next label
    if (
      inst.kind === TACInstructionKind.UnconditionalJump ||
      inst.kind === TACInstructionKind.Return
    ) {
      unreachable = true;
    }
  }

  return result;
};

export const eliminateDeadStoresCFG = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  const useMap = new Map<number, Set<string>>();
  const defMap = new Map<number, Set<string>>();

  for (const block of cfg.blocks) {
    const use = new Set<string>();
    const def = new Set<string>();
    for (let i = block.start; i <= block.end; i++) {
      const inst = instructions[i];
      for (const op of getUsedOperandsForReuse(inst)) {
        const key = livenessKey(op);
        if (!key) continue;
        if (!def.has(key)) {
          use.add(key);
        }
      }
      const defined = getDefinedOperandForReuse(inst);
      const defKey = livenessKey(defined);
      if (defKey) {
        def.add(defKey);
      }
    }
    useMap.set(block.id, use);
    defMap.set(block.id, def);
  }

  const liveIn = new Map<number, Set<string>>();
  const liveOut = new Map<number, Set<string>>();
  for (const block of cfg.blocks) {
    liveIn.set(block.id, new Set());
    liveOut.set(block.id, new Set());
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const block of cfg.blocks.slice().reverse()) {
      const out = new Set<string>();
      for (const succ of block.succs) {
        const succIn = liveIn.get(succ) ?? new Set();
        for (const key of succIn) out.add(key);
      }

      const use = useMap.get(block.id) ?? new Set();
      const def = defMap.get(block.id) ?? new Set();
      const inSet = new Set<string>(use);
      for (const key of out) {
        if (!def.has(key)) inSet.add(key);
      }

      const prevOut = liveOut.get(block.id) ?? new Set();
      const prevIn = liveIn.get(block.id) ?? new Set();
      if (!stringSetEqual(prevOut, out)) {
        liveOut.set(block.id, out);
        changed = true;
      }
      if (!stringSetEqual(prevIn, inSet)) {
        liveIn.set(block.id, inSet);
        changed = true;
      }
    }
  }

  const result: TACInstruction[] = [];
  for (const block of cfg.blocks) {
    const live = new Set(liveOut.get(block.id) ?? new Set());
    const kept: TACInstruction[] = [];
    for (let i = block.end; i >= block.start; i--) {
      const inst = instructions[i];
      const defOp = getDefinedOperandForReuse(inst);
      const defKey = livenessKey(defOp);
      const uses = getUsedOperandsForReuse(inst)
        .map((op) => livenessKey(op))
        .filter((key): key is string => Boolean(key));

      if (isPureProducer(inst) && defKey && !live.has(defKey)) {
        continue;
      }

      if (defKey) {
        live.delete(defKey);
      }
      for (const key of uses) {
        live.add(key);
      }
      kept.push(inst);
    }
    kept.reverse();
    result.push(...kept);
  }

  return result;
};

export const eliminateNoopCopies = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const result: TACInstruction[] = [];

  for (const inst of instructions) {
    if (
      inst.kind === TACInstructionKind.Assignment ||
      inst.kind === TACInstructionKind.Copy
    ) {
      const { dest, src } = inst as unknown as InstWithDestSrc;
      if (sameOperand(dest, src)) {
        continue;
      }
    }
    result.push(inst);
  }

  return result;
};

export const eliminateDeadTemporaries = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  let current = instructions;

  while (true) {
    const uses = new Map<number, number>();
    const recordUse = (operand: TACOperand) => {
      if (operand.kind !== TACOperandKind.Temporary) return;
      const id = (operand as TemporaryOperand).id;
      uses.set(id, (uses.get(id) ?? 0) + 1);
    };

    for (const inst of current) {
      for (const op of getUsedOperandsForReuse(inst)) {
        recordUse(op);
      }
    }

    let changed = false;
    const result: TACInstruction[] = [];
    for (const inst of current) {
      if (isPureProducer(inst)) {
        const defined = getDefinedOperandForReuse(inst);
        if (defined?.kind === TACOperandKind.Temporary) {
          const id = (defined as TemporaryOperand).id;
          if (!uses.has(id)) {
            changed = true;
            continue;
          }
        }
      }
      result.push(inst);
    }

    if (!changed) {
      return result;
    }
    current = result;
  }
};

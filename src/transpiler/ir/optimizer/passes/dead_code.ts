import type { TACInstruction } from "../../tac_instruction.js";
import { TACInstructionKind } from "../../tac_instruction.js";
import type { TACOperand, TemporaryOperand } from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import {
  type CFGPassOptions,
  MAX_FIXPOINT_ITERATIONS,
  type PassResult,
} from "../pass_types.js";
import {
  forEachUsedOperand,
  getDefinedOperandForReuse,
  type InstWithDestSrc,
  isPureProducer,
} from "../utils/instructions.js";
import { livenessKey } from "../utils/liveness.js";
import { sameOperand } from "../utils/operands.js";
import { stringSetEqual } from "../utils/sets.js";

/**
 * Dead code elimination
 * Remove unreachable code after unconditional jumps
 */
export const deadCodeElimination = (
  instructions: TACInstruction[],
): PassResult => {
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

  return {
    instructions: result,
    changed: result.length !== instructions.length,
  };
};

export const eliminateDeadStoresCFG = (
  instructions: TACInstruction[],
  options?: CFGPassOptions,
): PassResult => {
  const cfg = options?.cachedCFG ?? buildCFG(instructions);
  if (cfg.blocks.length === 0) return { instructions, changed: false };

  const useMap = new Map<number, Set<string>>();
  const defMap = new Map<number, Set<string>>();

  for (const block of cfg.blocks) {
    const use = new Set<string>();
    const def = new Set<string>();
    for (let i = block.start; i <= block.end; i++) {
      const inst = instructions[i];
      forEachUsedOperand(inst, (op) => {
        const key = livenessKey(op);
        if (!key) return;
        if (!def.has(key)) {
          use.add(key);
        }
      });
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

  const reversedBlocks = cfg.blocks.slice().reverse();
  const outScratch = new Set<string>();
  const inScratch = new Set<string>();
  let changed = true;
  let fixpointIter = 0;
  while (changed) {
    if (++fixpointIter > MAX_FIXPOINT_ITERATIONS) {
      console.warn(
        "[optimizer] dead-code liveness fixpoint hit iteration limit",
      );
      return { instructions, changed: false };
    }
    changed = false;
    for (const block of reversedBlocks) {
      outScratch.clear();
      for (const succ of block.succs) {
        const succIn = liveIn.get(succ);
        if (succIn) for (const key of succIn) outScratch.add(key);
      }

      const use = useMap.get(block.id);
      const def = defMap.get(block.id);
      inScratch.clear();
      if (use) for (const key of use) inScratch.add(key);
      for (const key of outScratch) {
        if (!def || !def.has(key)) inScratch.add(key);
      }

      const prevOut = liveOut.get(block.id) ?? new Set<string>();
      const prevIn = liveIn.get(block.id) ?? new Set<string>();
      if (!stringSetEqual(prevOut, outScratch)) {
        liveOut.set(block.id, new Set(outScratch));
        changed = true;
      }
      if (!stringSetEqual(prevIn, inScratch)) {
        liveIn.set(block.id, new Set(inScratch));
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
      if (isPureProducer(inst) && defKey && !live.has(defKey)) {
        continue;
      }

      if (defKey) {
        live.delete(defKey);
      }
      forEachUsedOperand(inst, (op) => {
        const key = livenessKey(op);
        if (key) live.add(key);
      });
      kept.push(inst);
    }
    kept.reverse();
    result.push(...kept);
  }

  return {
    instructions: result,
    changed: result.length !== instructions.length,
  };
};

export const eliminateNoopCopies = (
  instructions: TACInstruction[],
): PassResult => {
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

  return {
    instructions: result,
    changed: result.length !== instructions.length,
  };
};

export const eliminateDeadTemporaries = (
  instructions: TACInstruction[],
): PassResult => {
  let current = instructions;
  let anyChanged = false;

  while (true) {
    const uses = new Map<number, number>();
    const recordUse = (operand: TACOperand) => {
      if (operand.kind !== TACOperandKind.Temporary) return;
      const id = (operand as TemporaryOperand).id;
      uses.set(id, (uses.get(id) ?? 0) + 1);
    };

    for (const inst of current) {
      forEachUsedOperand(inst, recordUse);
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
            anyChanged = true;
            continue;
          }
        }
      }
      result.push(inst);
    }

    if (!changed) {
      return { instructions: result, changed: anyChanged };
    }
    current = result;
  }
};

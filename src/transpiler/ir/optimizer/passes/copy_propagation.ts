import {
  type ArrayAssignmentInstruction,
  type CopyInstruction,
  type PropertySetInstruction,
  type TACInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import type { TACOperand } from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";
import { type BasicBlock, buildCFG } from "../analysis/cfg.js";
import {
  getDefinedOperandForReuse,
  getUsedOperandsForReuse,
  rewriteOperands,
} from "../utils/instructions.js";
import { livenessKey } from "../utils/liveness.js";

type CopyMap = Map<string, TACOperand>;

// TOP sentinel: null means "all copies available" (identity for intersection)
type CopyMapOrTop = CopyMap | null;

/**
 * Intersect multiple copy maps, treating null as TOP (identity element).
 * intersect(TOP, M) == M; intersect(TOP, TOP) == TOP; intersect([], M) == empty.
 */
const intersectCopyMaps = (maps: CopyMapOrTop[]): CopyMapOrTop => {
  if (maps.length === 0) return new Map();
  let result: CopyMapOrTop = null; // start with TOP
  for (const m of maps) {
    if (m === null) continue; // TOP is identity
    if (result === null) {
      result = new Map(m);
      continue;
    }
    for (const [key, value] of result) {
      const otherValue = m.get(key);
      if (!otherValue || livenessKey(otherValue) !== livenessKey(value)) {
        result.delete(key);
      }
    }
  }
  return result;
};

/**
 * Compare two copy maps (or TOP sentinels) for equality.
 */
const copyMapsEqual = (a: CopyMapOrTop, b: CopyMapOrTop): boolean => {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const bValue = b.get(key);
    if (!bValue || livenessKey(bValue) !== livenessKey(value)) return false;
  }
  return true;
};

/**
 * Step through a single instruction, updating the copy map in place.
 * Optionally rewrites operands when rewrite callback is provided.
 */
const stepCopyState = (
  inst: TACInstruction,
  copies: CopyMap,
  rewrite: boolean,
): void => {
  // Skip labels
  if (inst.kind === TACInstructionKind.Label) return;

  // Invalidate copies for mutated objects
  const mutatedKey = getMutatedObjectKey(inst);
  if (mutatedKey) {
    copies.delete(mutatedKey);
  }

  // Rewrite used operands with copy sources
  if (rewrite) {
    const used = getUsedOperandsForReuse(inst);
    for (const operand of used) {
      const key = livenessKey(operand);
      if (key) {
        const resolved = resolve(copies, key, operand);
        if (resolved !== operand) {
          rewriteOperands(inst, (op) => {
            const opKey = livenessKey(op);
            if (opKey === key) return resolved;
            return op;
          });
        }
      }
    }
  }

  // Track copy definitions (only temp-to-temp)
  let insertedCopy = false;
  if (inst.kind === TACInstructionKind.Copy) {
    const typed = inst as unknown as CopyInstruction;
    if (typed.src.kind === TACOperandKind.Temporary) {
      const destKey = livenessKey(typed.dest);
      if (destKey && typed.dest.kind === TACOperandKind.Temporary) {
        copies.set(destKey, typed.src);
        insertedCopy = true;
      }
    }
  }

  // When an operand is defined, invalidate entries
  const defined = getDefinedOperandForReuse(inst);
  if (defined) {
    const defKey = livenessKey(defined);
    if (defKey) {
      if (!insertedCopy) {
        copies.delete(defKey);
      }
      for (const [key, value] of Array.from(copies.entries())) {
        if (livenessKey(value) === defKey && key !== defKey) {
          copies.delete(key);
        }
      }
    }
  }
};

/**
 * Propagate copies within a single block (analysis only, no rewrite).
 * Returns the output copy map.
 */
const propagateBlock = (
  instructions: TACInstruction[],
  block: BasicBlock,
  initialCopies: CopyMap,
): CopyMap => {
  const copies = new Map(initialCopies);
  for (let i = block.start; i <= block.end; i++) {
    stepCopyState(instructions[i], copies, false);
  }
  return copies;
};

/**
 * Final rewrite pass: use the computed input copy maps to rewrite operands.
 */
const rewriteWithCopyMaps = (
  instructions: TACInstruction[],
  cfg: { blocks: BasicBlock[] },
  inCopies: Map<number, CopyMapOrTop>,
): TACInstruction[] => {
  const result: TACInstruction[] = [];

  for (const block of cfg.blocks) {
    const rawIn = inCopies.get(block.id);
    const copies: CopyMap = new Map(rawIn ?? new Map());

    for (let i = block.start; i <= block.end; i++) {
      const inst = instructions[i];
      if (inst.kind === TACInstructionKind.Label) {
        result.push(inst);
        continue;
      }
      stepCopyState(inst, copies, true);
      result.push(inst);
    }
  }

  return result;
};

export const propagateCopies = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  // Initialize: entry block gets empty map, all others get TOP (null)
  const inCopies = new Map<number, CopyMapOrTop>();
  const outCopies = new Map<number, CopyMapOrTop>();
  for (const block of cfg.blocks) {
    inCopies.set(block.id, block.id === 0 ? new Map() : null);
    outCopies.set(block.id, block.id === 0 ? new Map() : null);
  }

  // Fixed-point iteration (capped to guard against accidental infinite loops)
  const maxIterations = cfg.blocks.length * 2 + 1;
  let changed = true;
  for (let iter = 0; iter < maxIterations && changed; iter++) {
    changed = false;
    for (const block of cfg.blocks) {
      // Input = intersection of all predecessor outputs
      // Pass raw values (including null/TOP) so intersectCopyMaps
      // can treat TOP as the identity element.
      const newIn = intersectCopyMaps(
        block.preds.map((id) => outCopies.get(id) ?? null),
      );

      // Propagate through block to compute output
      const inputMap: CopyMap = newIn ?? new Map();
      const newOut: CopyMapOrTop = propagateBlock(
        instructions,
        block,
        inputMap,
      );

      // Check for convergence
      const prev = outCopies.get(block.id);
      if (!copyMapsEqual(prev ?? null, newOut)) {
        outCopies.set(block.id, newOut);
        changed = true;
      }
      inCopies.set(block.id, newIn);
    }
  }

  // Final pass: rewrite operands using computed copy maps
  return rewriteWithCopyMaps(instructions, cfg, inCopies);
};

const resolve = (
  copies: CopyMap,
  key: string,
  original: TACOperand,
): TACOperand => {
  const visited = new Set<string>();
  let current = key;
  let resolved = original;
  while (copies.has(current) && !visited.has(current)) {
    visited.add(current);
    const val = copies.get(current);
    if (!val) break;
    resolved = val;
    const nextKey = livenessKey(resolved);
    if (!nextKey) break;
    current = nextKey;
  }
  return resolved;
};

const getMutatedObjectKey = (inst: TACInstruction): string | null => {
  if (inst.kind === TACInstructionKind.PropertySet) {
    return livenessKey((inst as unknown as PropertySetInstruction).object);
  }
  if (inst.kind === TACInstructionKind.ArrayAssignment) {
    return livenessKey((inst as unknown as ArrayAssignmentInstruction).array);
  }
  return null;
};

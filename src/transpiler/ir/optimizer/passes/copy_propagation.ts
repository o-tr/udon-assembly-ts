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

/**
 * Intersect multiple copy maps: keep only entries present in ALL maps
 * with the same operand value. Returns empty map when maps array is empty.
 */
const intersectCopyMaps = (
  maps: Map<string, TACOperand>[],
): Map<string, TACOperand> => {
  if (maps.length === 0) return new Map();
  const result = new Map(maps[0]);
  for (let i = 1; i < maps.length; i++) {
    const other = maps[i];
    for (const [key, value] of result) {
      const otherValue = other.get(key);
      if (!otherValue || livenessKey(otherValue) !== livenessKey(value)) {
        result.delete(key);
      }
    }
  }
  return result;
};

/**
 * Compare two copy maps for equality.
 */
const copyMapsEqual = (
  a: Map<string, TACOperand>,
  b: Map<string, TACOperand>,
): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const bValue = b.get(key);
    if (!bValue || livenessKey(bValue) !== livenessKey(value)) return false;
  }
  return true;
};

/**
 * Propagate copies within a single block, starting from an initial copy map.
 * Returns the output copy map after processing all instructions in the block.
 * Does NOT modify instructions (analysis only).
 */
const propagateBlock = (
  instructions: TACInstruction[],
  block: BasicBlock,
  initialCopies: Map<string, TACOperand>,
): Map<string, TACOperand> => {
  const copies = new Map(initialCopies);

  for (let i = block.start; i <= block.end; i++) {
    const inst = instructions[i];

    // Skip labels — they don't affect copy state within a block
    if (inst.kind === TACInstructionKind.Label) continue;

    // Invalidate copies for mutated objects
    const mutatedKey = getMutatedObjectKey(inst);
    if (mutatedKey) {
      copies.delete(mutatedKey);
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
        // Remove any entries whose copy source points to this operand
        for (const [key, value] of Array.from(copies.entries())) {
          if (livenessKey(value) === defKey && key !== defKey) {
            copies.delete(key);
          }
        }
      }
    }
  }

  return copies;
};

/**
 * Final rewrite pass: use the computed input copy maps to rewrite operands.
 */
const rewriteWithCopyMaps = (
  instructions: TACInstruction[],
  cfg: { blocks: BasicBlock[] },
  inCopies: Map<number, Map<string, TACOperand>>,
): TACInstruction[] => {
  const result: TACInstruction[] = [];

  for (const block of cfg.blocks) {
    const copies = new Map(inCopies.get(block.id) ?? new Map());

    for (let i = block.start; i <= block.end; i++) {
      const inst = instructions[i];

      if (inst.kind === TACInstructionKind.Label) {
        result.push(inst);
        continue;
      }

      // Invalidate copies for mutated objects
      const mutatedKey = getMutatedObjectKey(inst);
      if (mutatedKey) {
        copies.delete(mutatedKey);
      }

      // Rewrite used operands with copy sources
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

  // Initialize input/output copy maps for each block
  const inCopies = new Map<number, Map<string, TACOperand>>();
  const outCopies = new Map<number, Map<string, TACOperand>>();
  for (const block of cfg.blocks) {
    inCopies.set(block.id, new Map());
    outCopies.set(block.id, new Map());
  }

  // Fixed-point iteration
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of cfg.blocks) {
      // Input = intersection of all predecessor outputs
      const newIn = intersectCopyMaps(
        block.preds.map((id) => outCopies.get(id) ?? new Map()),
      );

      // Propagate through block to compute output
      const newOut = propagateBlock(instructions, block, newIn);

      // Check for convergence
      if (!copyMapsEqual(outCopies.get(block.id)!, newOut)) {
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
  copies: Map<string, TACOperand>,
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

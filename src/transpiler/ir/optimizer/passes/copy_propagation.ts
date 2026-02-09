import type { TACInstruction } from "../../tac_instruction.js";
import {
  type ArrayAssignmentInstruction,
  type CopyInstruction,
  type PropertySetInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import type { TACOperand, VariableOperand } from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";
import {
  getDefinedOperandForReuse,
  getUsedOperandsForReuse,
  rewriteOperands,
} from "../utils/instructions.js";
import { livenessKey } from "../utils/liveness.js";

export const propagateCopies = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const result: TACInstruction[] = [];
  // Map from operand liveness key to the operand it was copied from
  let copies = new Map<string, TACOperand>();

  for (const inst of instructions) {
    // Reset at block boundaries (labels and jumps)
    if (
      inst.kind === TACInstructionKind.Label ||
      inst.kind === TACInstructionKind.ConditionalJump ||
      inst.kind === TACInstructionKind.UnconditionalJump
    ) {
      copies = new Map();
      result.push(inst);
      continue;
    }

    // Don't propagate copies into the object of PropertySet or array of ArrayAssignment.
    // These represent in-place mutation where the copy is semantically significant
    // (needed for copy-on-write semantics later in the pipeline).
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

    // Track copy definitions (only explicit Copy instructions, not Assignment)
    // Only propagate temp-to-temp copies to avoid interfering with other passes
    if (inst.kind === TACInstructionKind.Copy) {
      const typed = inst as CopyInstruction;
      if (typed.src.kind === TACOperandKind.Temporary) {
        const destKey = livenessKey(typed.dest);
        if (destKey && typed.dest.kind === TACOperandKind.Temporary) {
          copies.set(destKey, typed.src);
        }
      }
    }

    // When an operand is defined, invalidate entries
    const defined = getDefinedOperandForReuse(inst);
    if (defined) {
      const defKey = livenessKey(defined);
      if (defKey) {
        // Remove from copies map if redefined (unless we just set it above for Assignment/Copy)
        if (
          inst.kind !== TACInstructionKind.Assignment &&
          inst.kind !== TACInstructionKind.Copy
        ) {
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

    result.push(inst);
  }

  return result;
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
    return livenessKey((inst as PropertySetInstruction).object);
  }
  if (inst.kind === TACInstructionKind.ArrayAssignment) {
    return livenessKey((inst as ArrayAssignmentInstruction).array);
  }
  return null;
};

const _isExportedVariable = (operand: TACOperand): boolean => {
  if (operand.kind !== TACOperandKind.Variable) return false;
  return (operand as VariableOperand).isExported === true;
};

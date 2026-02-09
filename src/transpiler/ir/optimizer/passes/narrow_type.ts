import { UdonType } from "../../../frontend/types.js";
import {
  type BinaryOpInstruction,
  type CastInstruction,
  type TACInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import {
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
} from "../../tac_operand.js";
import {
  getDefinedOperandForReuse,
  getUsedOperandsForReuse,
  rewriteOperands,
} from "../utils/instructions.js";
import { livenessKey } from "../utils/liveness.js";
import { getOperandType } from "./constant_folding.js";

const TYPE_WIDTH: Partial<Record<UdonType, number>> = {
  [UdonType.Byte]: 8,
  [UdonType.SByte]: 8,
  [UdonType.Int16]: 16,
  [UdonType.UInt16]: 16,
  [UdonType.Int32]: 32,
  [UdonType.UInt32]: 32,
  [UdonType.Int64]: 64,
  [UdonType.UInt64]: 64,
};

const isComparisonOperator = (op: string): boolean => {
  return (
    op === "<" ||
    op === ">" ||
    op === "<=" ||
    op === ">=" ||
    op === "==" ||
    op === "!="
  );
};

/**
 * Narrow type optimization: eliminate redundant widening casts when the
 * result is only used in comparisons that would produce the same result
 * at the narrower width.
 */
export const narrowTypes = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  // Phase 1: Find Cast instructions that widen integer types
  const castCandidates = new Map<
    string,
    { castIndex: number; castInst: CastInstruction; srcOperand: TACOperand }
  >();

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    if (inst.kind !== TACInstructionKind.Cast) continue;
    const castInst = inst as CastInstruction;
    if (castInst.dest.kind !== TACOperandKind.Temporary) continue;

    const srcType = getOperandType(castInst.src).udonType;
    const destType = getOperandType(castInst.dest).udonType;
    const srcWidth = TYPE_WIDTH[srcType as UdonType];
    const destWidth = TYPE_WIDTH[destType as UdonType];
    if (!srcWidth || !destWidth || srcWidth >= destWidth) continue;

    const destKey = livenessKey(castInst.dest);
    if (!destKey) continue;

    // Check the cast dest is only defined once
    let defCount = 0;
    for (const otherInst of instructions) {
      const def = getDefinedOperandForReuse(otherInst);
      if (def && livenessKey(def) === destKey) defCount++;
    }
    if (defCount !== 1) continue;

    castCandidates.set(destKey, {
      castIndex: i,
      castInst,
      srcOperand: castInst.src,
    });
  }

  if (castCandidates.size === 0) return instructions;

  // Phase 2: For each cast candidate, check all uses
  const eliminable = new Set<string>();

  for (const [destKey, candidate] of castCandidates) {
    let allUsesAreComparisons = true;
    let hasUses = false;

    for (const inst of instructions) {
      const usedOps = getUsedOperandsForReuse(inst);
      const usesCandidate = usedOps.some(
        (op) => livenessKey(op) === destKey,
      );
      if (!usesCandidate) continue;
      hasUses = true;

      // Check if this is a comparison BinaryOp
      if (inst.kind !== TACInstructionKind.BinaryOp) {
        allUsesAreComparisons = false;
        break;
      }
      const bin = inst as BinaryOpInstruction;
      if (!isComparisonOperator(bin.operator)) {
        allUsesAreComparisons = false;
        break;
      }

      // Check the other operand is a constant that fits in the narrow type
      const srcType = getOperandType(candidate.srcOperand).udonType;
      const srcWidth = TYPE_WIDTH[srcType as UdonType];
      if (!srcWidth) {
        allUsesAreComparisons = false;
        break;
      }

      // Find the "other" operand (the one that's not the cast result)
      const otherOp =
        livenessKey(bin.left) === destKey ? bin.right : bin.left;
      if (otherOp.kind !== TACOperandKind.Constant) {
        allUsesAreComparisons = false;
        break;
      }
    }

    if (allUsesAreComparisons && hasUses) {
      eliminable.add(destKey);
    }
  }

  if (eliminable.size === 0) return instructions;

  // Phase 3: Rewrite uses and remove casts
  const result: TACInstruction[] = [];
  for (const inst of instructions) {
    // Remove eliminable casts
    if (inst.kind === TACInstructionKind.Cast) {
      const castInst = inst as CastInstruction;
      const destKey = livenessKey(castInst.dest);
      if (destKey && eliminable.has(destKey)) {
        continue;
      }
    }

    // Rewrite operands: replace cast dest with cast src
    rewriteOperands(inst, (op: TACOperand): TACOperand => {
      const key = livenessKey(op);
      if (key && eliminable.has(key)) {
        const candidate = castCandidates.get(key);
        if (candidate) return candidate.srcOperand;
      }
      return op;
    });

    result.push(inst);
  }

  return result;
};

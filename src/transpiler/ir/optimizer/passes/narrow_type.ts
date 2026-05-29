import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import { UdonType } from "../../../frontend/types.js";
import {
  type BinaryOpInstruction,
  type CastInstruction,
  type TACInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import {
  type ConstantOperand,
  createConstant,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import type { PassResult } from "../pass_types.js";
import {
  forEachUsedOperand,
  getDefinedOperandForReuse,
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

const SIGNED_TYPES = new Set<UdonType>([
  UdonType.SByte,
  UdonType.Int16,
  UdonType.Int32,
  UdonType.Int64,
]);

const isSigned = (typeName: UdonType): boolean => {
  return SIGNED_TYPES.has(typeName);
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

const getIntegerRangeForUdonType = (
  typeName: UdonType,
): { min: bigint; max: bigint } | null => {
  const width = TYPE_WIDTH[typeName as UdonType];
  if (!width) return null;
  const bits = BigInt(width);
  switch (typeName) {
    case UdonType.Byte:
    case UdonType.UInt16:
    case UdonType.UInt32:
    case UdonType.UInt64: {
      const min = 0n;
      const max = (1n << bits) - 1n;
      return { min, max };
    }
    case UdonType.SByte:
    case UdonType.Int16:
    case UdonType.Int32:
    case UdonType.Int64: {
      const half = bits - 1n;
      const min = -(1n << half);
      const max = (1n << half) - 1n;
      return { min, max };
    }
    default:
      return null;
  }
};

/**
 * Narrow type optimization: eliminate redundant widening casts when the
 * result is only used in comparisons that would produce the same result
 * at the narrower width.
 */
export const narrowTypes = (instructions: TACInstruction[]): PassResult => {
  // Phase 1: Find Cast instructions that widen integer types, and count
  // definitions once. The old implementation rescanned the full instruction
  // list for each cast candidate, which is prohibitive for generated TAC.
  type Candidate = {
    srcOperand: TACOperand;
    range: { min: bigint; max: bigint };
  };
  const castCandidates = new Map<string, Candidate>();
  const defCounts = new Map<string, number>();

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    const def = getDefinedOperandForReuse(inst);
    const defKey = def ? livenessKey(def) : undefined;
    if (defKey) {
      defCounts.set(defKey, (defCounts.get(defKey) ?? 0) + 1);
    }

    if (inst.kind !== TACInstructionKind.Cast) continue;
    const castInst = inst as CastInstruction;
    if (castInst.dest.kind !== TACOperandKind.Temporary) continue;

    const srcType = getOperandType(castInst.src).udonType;
    const destType = getOperandType(castInst.dest).udonType;
    const srcWidth = TYPE_WIDTH[srcType as UdonType];
    const destWidth = TYPE_WIDTH[destType as UdonType];
    if (!srcWidth || !destWidth || srcWidth >= destWidth) continue;
    if (isSigned(srcType as UdonType) !== isSigned(destType as UdonType)) {
      continue;
    }

    const destKey = livenessKey(castInst.dest);
    if (!destKey) continue;

    const candidateSrcType = getOperandType(castInst.src).udonType as UdonType;
    const range = getIntegerRangeForUdonType(candidateSrcType);
    if (!range) continue;

    castCandidates.set(destKey, {
      srcOperand: castInst.src,
      range,
    });
  }

  for (const key of [...castCandidates.keys()]) {
    if ((defCounts.get(key) ?? 0) !== 1) {
      castCandidates.delete(key);
    }
  }

  if (castCandidates.size === 0) return { instructions, changed: false };

  // Phase 2: Check all candidate uses in a single pass.
  const useState = new Map<
    string,
    { allUsesAreComparisons: boolean; hasUses: boolean }
  >();
  for (const key of castCandidates.keys()) {
    useState.set(key, { allUsesAreComparisons: true, hasUses: false });
  }

  for (const inst of instructions) {
    forEachUsedOperand(inst, (op) => {
      const destKey = livenessKey(op);
      if (!destKey) return;
      const candidate = castCandidates.get(destKey);
      if (!candidate) return;
      const state = useState.get(destKey);
      if (!state || !state.allUsesAreComparisons) return;
      state.hasUses = true;

      // Check if this is a comparison BinaryOp
      if (inst.kind !== TACInstructionKind.BinaryOp) {
        state.allUsesAreComparisons = false;
        return;
      }
      const bin = inst as BinaryOpInstruction;
      if (!isComparisonOperator(bin.operator)) {
        state.allUsesAreComparisons = false;
        return;
      }

      // Check the other operand is a constant that fits in the narrow type
      const srcType = getOperandType(candidate.srcOperand).udonType;
      const srcWidth = TYPE_WIDTH[srcType as UdonType];
      if (!srcWidth) {
        state.allUsesAreComparisons = false;
        return;
      }

      // Find the "other" operand (the one that's not the cast result)
      const otherOp = livenessKey(bin.left) === destKey ? bin.right : bin.left;
      if (otherOp.kind !== TACOperandKind.Constant) {
        state.allUsesAreComparisons = false;
        return;
      }

      // Ensure the constant is representable in the source (narrow) type
      const constOp = otherOp as ConstantOperand;
      const _otherType = getOperandType(otherOp).udonType as UdonType;

      const rawVal = constOp.value;
      let constBigInt: bigint | null = null;
      if (typeof rawVal === "bigint") {
        constBigInt = rawVal as bigint;
      } else if (typeof rawVal === "number") {
        if (!Number.isFinite(rawVal) || !Number.isInteger(rawVal)) {
          state.allUsesAreComparisons = false;
          return;
        }
        constBigInt = BigInt(Math.trunc(rawVal));
      } else {
        // Non-integer constant: unsafe
        state.allUsesAreComparisons = false;
        return;
      }

      if (
        constBigInt < candidate.range.min ||
        constBigInt > candidate.range.max
      ) {
        state.allUsesAreComparisons = false;
      }
    });
  }

  const eliminable = new Set<string>();
  for (const [destKey, state] of useState) {
    if (state.allUsesAreComparisons && state.hasUses) {
      eliminable.add(destKey);
    }
  }

  if (eliminable.size === 0) return { instructions, changed: false };

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
    let narrowType: TypeSymbol | null = null;
    rewriteOperands(inst, (op: TACOperand): TACOperand => {
      const key = livenessKey(op);
      if (key && eliminable.has(key)) {
        const candidate = castCandidates.get(key);
        if (candidate) {
          narrowType = getOperandType(candidate.srcOperand);
          return candidate.srcOperand;
        }
      }
      return op;
    });

    if (narrowType && inst.kind === TACInstructionKind.BinaryOp) {
      const bin = inst as BinaryOpInstruction;
      if (isComparisonOperator(bin.operator)) {
        if (bin.left.kind === TACOperandKind.Constant) {
          const c = bin.left as ConstantOperand;
          bin.left = createConstant(c.value, narrowType);
        }
        if (bin.right.kind === TACOperandKind.Constant) {
          const c = bin.right as ConstantOperand;
          bin.right = createConstant(c.value, narrowType);
        }
      }
    }

    result.push(inst);
  }

  return { instructions: result, changed: true };
};

import {
  type AssignmentInstruction,
  type TACInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import {
  type ConstantOperand,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
} from "../../tac_operand.js";
import {
  getDefinedOperandForReuse,
  rewriteOperands,
} from "../utils/instructions.js";
import { stringifyConstant } from "../utils/operands.js";
import { getOperandType } from "./constant_folding.js";

/**
 * Constant deduplication: merge temporaries that hold the same constant value
 * into a single canonical temporary, reducing heap slot usage.
 */
export const deduplicateConstants = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  // Collect definitions for temporaries: count definitions and remember
  // single-def constant assignments.
  const tempInfo = new Map<
    number,
    { defCount: number; constOp?: ConstantOperand | null; defIndex?: number }
  >();

  for (let idx = 0; idx < instructions.length; idx++) {
    const inst = instructions[idx];
    const def = getDefinedOperandForReuse(inst);
    if (!def || def.kind !== TACOperandKind.Temporary) continue;
    const tid = (def as TemporaryOperand).id;
    const entry = tempInfo.get(tid) ?? { defCount: 0, constOp: null };
    entry.defCount = entry.defCount + 1;
    entry.defIndex = entry.defIndex ?? idx;
    // If this defining instruction is an assignment of a constant, record it
    if (inst.kind === TACInstructionKind.Assignment) {
      const assign = inst as AssignmentInstruction;
      if (assign.src.kind === TACOperandKind.Constant) {
        entry.constOp = assign.src as ConstantOperand;
      }
    }
    tempInfo.set(tid, entry);
  }

  // Group temps that are single-def and assigned the same constant value/type
  const groups = new Map<string, number[]>();
  for (const [tid, info] of tempInfo) {
    if (info.defCount !== 1) continue;
    if (!info.constOp) continue;
    const typeKey = getOperandType(info.constOp).udonType;
    const groupKey = `${stringifyConstant(info.constOp.value)}|${typeKey}`;
    const g = groups.get(groupKey) ?? [];
    g.push(tid);
    groups.set(groupKey, g);
  }

  // Build rewrite map (non-canonical -> canonical temporary operand)
  const rewriteMap = new Map<number, TemporaryOperand>();
  const removableAssignments = new Set<number>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a - b);
    const canonicalId = group[0];
    const canonicalEntry = tempInfo.get(canonicalId);
    if (!canonicalEntry || !canonicalEntry.constOp) continue;
    const canonicalType = getOperandType(canonicalEntry.constOp);
    for (let i = 1; i < group.length; i++) {
      const tid = group[i];
      rewriteMap.set(tid, {
        kind: TACOperandKind.Temporary,
        id: canonicalId,
        type: canonicalType,
      } as TemporaryOperand);
      removableAssignments.add(tid);
    }
  }

  if (rewriteMap.size === 0) return instructions;

  // Phase 4: Rewrite uses and remove non-canonical assignments
  const result: TACInstruction[] = [];
  for (const inst of instructions) {
    // Remove non-canonical constant assignments
    if (
      inst.kind === TACInstructionKind.Assignment ||
      inst.kind === TACInstructionKind.Copy
    ) {
      const assign = inst as AssignmentInstruction;
      if (
        assign.dest.kind === TACOperandKind.Temporary &&
        removableAssignments.has((assign.dest as TemporaryOperand).id)
      ) {
        continue;
      }
    }

    // Rewrite operands
    rewriteOperands(inst, (op: TACOperand): TACOperand => {
      if (op.kind === TACOperandKind.Temporary) {
        const replacement = rewriteMap.get((op as TemporaryOperand).id);
        if (replacement) return replacement;
      }
      return op;
    });

    result.push(inst);
  }

  return result;
};

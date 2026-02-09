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
  // Phase 1: Find all temps defined exactly once by a constant assignment
  const tempDefs = new Map<
    number,
    { value: ConstantOperand; defCount: number }
  >();

  for (const inst of instructions) {
    if (
      inst.kind !== TACInstructionKind.Assignment &&
      inst.kind !== TACInstructionKind.Copy
    ) {
      const def = getDefinedOperandForReuse(inst);
      if (def?.kind === TACOperandKind.Temporary) {
        const id = (def as TemporaryOperand).id;
        const existing = tempDefs.get(id);
        if (existing) {
          existing.defCount++;
        }
      }
      continue;
    }

    const assign = inst as AssignmentInstruction;
    if (assign.dest.kind !== TACOperandKind.Temporary) continue;

    const tempId = (assign.dest as TemporaryOperand).id;
    const existing = tempDefs.get(tempId);
    if (existing) {
      existing.defCount++;
      continue;
    }

    if (assign.src.kind === TACOperandKind.Constant) {
      tempDefs.set(tempId, {
        value: assign.src as ConstantOperand,
        defCount: 1,
      });
    } else {
      // Defined by non-constant — record as non-candidate
      tempDefs.set(tempId, {
        value: undefined as unknown as ConstantOperand,
        defCount: 1,
      });
    }
  }

  // Phase 2: Group single-def constant temps by (value, udonType)
  const groups = new Map<string, number[]>();
  for (const [tempId, info] of tempDefs) {
    if (info.defCount !== 1) continue;
    if (!info.value || info.value.kind !== TACOperandKind.Constant) continue;

    const constOp = info.value;
    const typeKey = getOperandType(constOp).udonType;
    const groupKey = `${stringifyConstant(constOp.value)}|${typeKey}`;

    const group = groups.get(groupKey) ?? [];
    group.push(tempId);
    groups.set(groupKey, group);
  }

  // Phase 3: Build rewrite map (non-canonical → canonical temp operand)
  const rewriteMap = new Map<number, TACOperand>();
  const removableAssignments = new Set<number>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a - b);
    const canonicalId = group[0];
    // Find the canonical temp operand from its definition
    const canonicalInfo = tempDefs.get(canonicalId);
    if (!canonicalInfo) continue;

    for (let i = 1; i < group.length; i++) {
      rewriteMap.set(group[i], {
        kind: TACOperandKind.Temporary,
        id: canonicalId,
        type: getOperandType(canonicalInfo.value),
      } as TemporaryOperand);
      removableAssignments.add(group[i]);
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

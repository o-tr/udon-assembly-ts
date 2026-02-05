import type { TACInstruction } from "../../tac_instruction.js";
import {
  AssignmentInstruction,
  TACInstructionKind,
  type UnaryOpInstruction,
} from "../../tac_instruction.js";
import { TACOperandKind, type TemporaryOperand } from "../../tac_operand.js";
import {
  countTempUses,
  getDefinedOperandForReuse,
} from "../utils/instructions.js";
import { operandKey } from "../utils/operands.js";

export const doubleNegationElimination = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const tempUses = countTempUses(instructions);
  const lastDefinition = new Map<string, number>();
  const removed = new Set<number>();
  const replacements = new Map<number, TACInstruction>();

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    if (inst.kind === TACInstructionKind.UnaryOp) {
      const outer = inst as UnaryOpInstruction;
      if (
        outer.operator === "!" &&
        outer.operand.kind === TACOperandKind.Temporary
      ) {
        const operandTemp = outer.operand as TemporaryOperand;
        const defIndex = lastDefinition.get(operandKey(outer.operand));
        if (defIndex !== undefined) {
          const defInst = instructions[defIndex];
          if (defInst.kind === TACInstructionKind.UnaryOp) {
            const inner = defInst as UnaryOpInstruction;
            if (inner.operator === "!" && tempUses.get(operandTemp.id) === 1) {
              replacements.set(
                i,
                new AssignmentInstruction(outer.dest, inner.operand),
              );
              removed.add(defIndex);
            }
          }
        }
      }
    }

    const defined = getDefinedOperandForReuse(inst);
    if (defined) {
      lastDefinition.set(operandKey(defined), i);
    }
  }

  const result: TACInstruction[] = [];
  for (let i = 0; i < instructions.length; i++) {
    if (removed.has(i)) continue;
    result.push(replacements.get(i) ?? instructions[i]);
  }

  return result;
};

import type { TACInstruction } from "../../tac_instruction.js";
import {
  BinaryOpInstruction,
  TACInstructionKind,
  type UnaryOpInstruction,
} from "../../tac_instruction.js";
import { TACOperandKind, type TemporaryOperand } from "../../tac_operand.js";
import {
  countTempUses,
  getDefinedOperandForReuse,
} from "../utils/instructions.js";
import { operandKey } from "../utils/operands.js";

const invertComparison: Record<string, string> = {
  "<": ">=",
  ">": "<=",
  "<=": ">",
  ">=": "<",
  "==": "!=",
  "!=": "==",
};

export const negatedComparisonFusion = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const tempUses = countTempUses(instructions);
  const lastDefinition = new Map<string, number>();
  const removed = new Set<number>();
  const replacements = new Map<number, TACInstruction>();

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    if (inst.kind === TACInstructionKind.UnaryOp) {
      const un = inst as UnaryOpInstruction;
      if (un.operator === "!" && un.operand.kind === TACOperandKind.Temporary) {
        const operandTemp = un.operand as TemporaryOperand;
        const defIndex = lastDefinition.get(operandKey(un.operand));
        if (defIndex !== undefined) {
          const defInst = instructions[defIndex];
          if (defInst.kind === TACInstructionKind.BinaryOp) {
            const bin = defInst as BinaryOpInstruction;
            const inverted = invertComparison[bin.operator];
            if (inverted && tempUses.get(operandTemp.id) === 1) {
              replacements.set(
                i,
                new BinaryOpInstruction(un.dest, bin.left, inverted, bin.right),
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

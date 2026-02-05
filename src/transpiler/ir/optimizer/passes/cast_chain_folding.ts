import type { TACInstruction } from "../../tac_instruction.js";
import { CastInstruction, TACInstructionKind } from "../../tac_instruction.js";
import { TACOperandKind, type TemporaryOperand } from "../../tac_operand.js";
import {
  countTempUses,
  getDefinedOperandForReuse,
} from "../utils/instructions.js";
import { operandKey } from "../utils/operands.js";
import {
  getOperandType,
  isFloatUdonType,
  isIntegerUdonType,
} from "./constant_folding.js";

export const castChainFolding = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const tempUses = countTempUses(instructions);
  const lastDefinition = new Map<string, number>();
  const removed = new Set<number>();
  const replacements = new Map<number, TACInstruction>();

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    if (inst.kind === TACInstructionKind.Label) {
      lastDefinition.clear();
    }

    if (inst.kind === TACInstructionKind.Cast) {
      const outer = inst as CastInstruction;
      if (outer.src.kind === TACOperandKind.Temporary) {
        const operandTemp = outer.src as TemporaryOperand;
        const defIndex = lastDefinition.get(operandKey(outer.src));
        if (defIndex !== undefined) {
          const defInst = instructions[defIndex];
          if (defInst.kind === TACInstructionKind.Cast) {
            const inner = defInst as CastInstruction;
            const innerSrcType = getOperandType(inner.src).udonType;
            const intermediateType = getOperandType(inner.dest).udonType;
            if (
              tempUses.get(operandTemp.id) === 1 &&
              !(
                isFloatUdonType(innerSrcType) &&
                isIntegerUdonType(intermediateType)
              )
            ) {
              replacements.set(i, new CastInstruction(outer.dest, inner.src));
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

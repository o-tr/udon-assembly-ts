import { PrimitiveTypes } from "../../../frontend/type_symbols.js";
import type { TACInstruction } from "../../tac_instruction.js";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  TACInstructionKind,
  type UnaryOpInstruction,
} from "../../tac_instruction.js";
import { TACOperandKind, type TemporaryOperand } from "../../tac_operand.js";
import type { PassResult } from "../pass_types.js";
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

const isKnownBooleanOperand = (
  operand: UnaryOpInstruction["operand"],
): boolean => {
  const typed = operand as { type?: { udonType?: unknown } };
  return typed.type?.udonType === PrimitiveTypes.boolean.udonType;
};

export const negatedComparisonFusion = (
  instructions: TACInstruction[],
): PassResult => {
  const tempUses = countTempUses(instructions);
  const lastDefinition = new Map<string, number>();
  const removed = new Set<number>();
  const replacements = new Map<number, TACInstruction>();

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    if (inst.kind === TACInstructionKind.Label) {
      lastDefinition.clear();
    }
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

  const changed = removed.size > 0 || replacements.size > 0;
  if (!changed) return { instructions, changed: false };

  const result: TACInstruction[] = [];
  for (let i = 0; i < instructions.length; i++) {
    if (removed.has(i)) continue;
    result.push(replacements.get(i) ?? instructions[i]);
  }

  return { instructions: result, changed: true };
};

export const booleanNegationFusion = (
  instructions: TACInstruction[],
): PassResult => {
  const tempUses = countTempUses(instructions);
  const lastDefinition = new Map<string, number>();
  const removed = new Set<number>();
  const replacements = new Map<number, TACInstruction>();

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    if (inst.kind === TACInstructionKind.Label) {
      lastDefinition.clear();
    }

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
          if (defInst.kind === TACInstructionKind.BinaryOp) {
            const bin = defInst as BinaryOpInstruction;
            const inverted = invertComparison[bin.operator];
            if (inverted && tempUses.get(operandTemp.id) === 1) {
              replacements.set(
                i,
                new BinaryOpInstruction(
                  outer.dest,
                  bin.left,
                  inverted,
                  bin.right,
                ),
              );
              removed.add(defIndex);
            }
          } else if (defInst.kind === TACInstructionKind.UnaryOp) {
            const inner = defInst as UnaryOpInstruction;
            if (
              inner.operator === "!" &&
              tempUses.get(operandTemp.id) === 1 &&
              isKnownBooleanOperand(inner.operand)
            ) {
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

  const changed = removed.size > 0 || replacements.size > 0;
  if (!changed) return { instructions, changed: false };

  const result: TACInstruction[] = [];
  for (let i = 0; i < instructions.length; i++) {
    if (removed.has(i)) continue;
    result.push(replacements.get(i) ?? instructions[i]);
  }

  return { instructions: result, changed: true };
};

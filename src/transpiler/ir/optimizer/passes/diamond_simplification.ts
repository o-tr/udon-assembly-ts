import {
  AssignmentInstruction,
  type LabelInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnaryOpInstruction,
  ConditionalJumpInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  type ConstantOperand,
  type LabelOperand,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import { operandKey } from "../utils/operands.js";

type InstWithDestSrc = { dest: TACOperand; src: TACOperand };

export const simplifyDiamondPatterns = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  // Count label usage (how many jumps target each label)
  const labelUses = new Map<string, number>();
  for (const inst of instructions) {
    if (inst.kind === TACInstructionKind.ConditionalJump) {
      const label = (inst as unknown as ConditionalJumpInstruction).label;
      if (label.kind === TACOperandKind.Label) {
        const name = (label as LabelOperand).name;
        labelUses.set(name, (labelUses.get(name) ?? 0) + 1);
      }
    }
    if (inst.kind === TACInstructionKind.UnconditionalJump) {
      const label = (inst as unknown as UnconditionalJumpInstruction).label;
      if (label.kind === TACOperandKind.Label) {
        const name = (label as LabelOperand).name;
        labelUses.set(name, (labelUses.get(name) ?? 0) + 1);
      }
    }
  }

  const result: TACInstruction[] = [];
  let i = 0;
  while (i < instructions.length) {
    // Need at least 6 instructions for the diamond: condJump, assign, uncondJump, label, assign, label
    if (i + 5 >= instructions.length) {
      result.push(instructions[i]);
      i++;
      continue;
    }
    const inst = instructions[i];
    if (inst.kind !== TACInstructionKind.ConditionalJump) {
      result.push(inst);
      i++;
      continue;
    }
    const condJump = inst as unknown as ConditionalJumpInstruction;
    if (condJump.label.kind !== TACOperandKind.Label) {
      result.push(inst);
      i++;
      continue;
    }
    const elseLabel = (condJump.label as LabelOperand).name;

    // Check pattern: thenAssign, uncondJump, elseLabel, elseAssign, joinLabel
    const thenInst = instructions[i + 1];
    const uncondJump = instructions[i + 2];
    const elseLabelInst = instructions[i + 3];
    const elseInst = instructions[i + 4];
    const joinLabelInst = instructions[i + 5];

    if (!isConstantAssignment(thenInst)) {
      result.push(inst);
      i++;
      continue;
    }
    if (uncondJump.kind !== TACInstructionKind.UnconditionalJump) {
      result.push(inst);
      i++;
      continue;
    }
    const joinLabel = (uncondJump as unknown as UnconditionalJumpInstruction)
      .label;
    if (joinLabel.kind !== TACOperandKind.Label) {
      result.push(inst);
      i++;
      continue;
    }
    const joinName = (joinLabel as LabelOperand).name;

    if (elseLabelInst.kind !== TACInstructionKind.Label) {
      result.push(inst);
      i++;
      continue;
    }
    const elseLabelActual = (elseLabelInst as unknown as LabelInstruction)
      .label;
    if (elseLabelActual.kind !== TACOperandKind.Label) {
      result.push(inst);
      i++;
      continue;
    }
    if ((elseLabelActual as LabelOperand).name !== elseLabel) {
      result.push(inst);
      i++;
      continue;
    }

    if (!isConstantAssignment(elseInst)) {
      result.push(inst);
      i++;
      continue;
    }

    if (joinLabelInst.kind !== TACInstructionKind.Label) {
      result.push(inst);
      i++;
      continue;
    }
    const joinLabelActual = (joinLabelInst as unknown as LabelInstruction)
      .label;
    if (joinLabelActual.kind !== TACOperandKind.Label) {
      result.push(inst);
      i++;
      continue;
    }
    if ((joinLabelActual as LabelOperand).name !== joinName) {
      result.push(inst);
      i++;
      continue;
    }

    // Check same destination
    const thenAssign = thenInst as unknown as InstWithDestSrc;
    const elseAssign = elseInst as unknown as InstWithDestSrc;
    if (operandKey(thenAssign.dest) !== operandKey(elseAssign.dest)) {
      result.push(inst);
      i++;
      continue;
    }

    // Check labels used only once (by this diamond)
    if ((labelUses.get(elseLabel) ?? 0) !== 1) {
      result.push(inst);
      i++;
      continue;
    }
    if ((labelUses.get(joinName) ?? 0) !== 1) {
      result.push(inst);
      i++;
      continue;
    }

    // Both are boolean constants?
    const thenVal = getConstantBoolean(thenAssign.src);
    const elseVal = getConstantBoolean(elseAssign.src);
    if (thenVal === null || elseVal === null || thenVal === elseVal) {
      result.push(inst);
      i++;
      continue;
    }

    // ifFalse means: if condition is FALSE, jump to else.
    // So fallthrough (thenInst) executes when condition is TRUE.
    // thenVal=true, elseVal=false → dest = condition
    // thenVal=false, elseVal=true → dest = !condition
    if (thenVal === true) {
      result.push(
        new AssignmentInstruction(thenAssign.dest, condJump.condition),
      );
    } else {
      result.push(
        new UnaryOpInstruction(thenAssign.dest, "!", condJump.condition),
      );
    }
    // Keep the join label in case something else references it
    result.push(joinLabelInst);
    i += 6;
  }
  return result;
};

const isConstantAssignment = (inst: TACInstruction): boolean => {
  if (
    inst.kind !== TACInstructionKind.Assignment &&
    inst.kind !== TACInstructionKind.Copy
  ) {
    return false;
  }
  const assign = inst as unknown as InstWithDestSrc;
  return assign.src.kind === TACOperandKind.Constant;
};

const getConstantBoolean = (operand: TACOperand): boolean | null => {
  if (operand.kind !== TACOperandKind.Constant) return null;
  const val = (operand as ConstantOperand).value;
  if (typeof val !== "boolean") return null;
  return val;
};

import {
  type AssignmentInstruction,
  type BinaryOpInstruction,
  type ConditionalJumpInstruction,
  type LabelInstruction,
  type TACInstruction,
  TACInstructionKind,
  type UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import type {
  ConstantOperand,
  LabelOperand,
  TACOperand,
  VariableOperand,
} from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";
import { getDefinedOperandForReuse } from "../utils/instructions.js";
import { livenessKey } from "../utils/liveness.js";

const collectLabelIndices = (
  instructions: TACInstruction[],
): Map<string, number> => {
  const map = new Map<string, number>();
  for (let i = 0; i < instructions.length; i += 1) {
    const inst = instructions[i];
    if (inst.kind !== TACInstructionKind.Label) continue;
    const labelInst = inst as LabelInstruction;
    if (labelInst.label.kind !== TACOperandKind.Label) continue;
    map.set((labelInst.label as LabelOperand).name, i);
  }
  return map;
};

const collectLabelUses = (
  instructions: TACInstruction[],
): Map<string, number> => {
  const map = new Map<string, number>();
  const bump = (label: string) => map.set(label, (map.get(label) ?? 0) + 1);
  for (const inst of instructions) {
    if (
      inst.kind === TACInstructionKind.UnconditionalJump ||
      inst.kind === TACInstructionKind.ConditionalJump
    ) {
      const label = (
        inst as UnconditionalJumpInstruction | ConditionalJumpInstruction
      ).label;
      if (label.kind === TACOperandKind.Label) {
        bump((label as LabelOperand).name);
      }
    }
  }
  return map;
};

const isNumericConstant = (operand: TACOperand): operand is ConstantOperand => {
  if (operand.kind !== TACOperandKind.Constant) return false;
  return typeof (operand as ConstantOperand).value === "number";
};

const isSimpleIncrement = (
  inst: TACInstruction,
  variableKey: string,
): { step: number } | null => {
  if (inst.kind !== TACInstructionKind.BinaryOp) return null;
  const bin = inst as BinaryOpInstruction;
  if (bin.operator !== "+" && bin.operator !== "-") return null;
  if (bin.dest.kind !== TACOperandKind.Variable) return null;
  if (bin.left.kind !== TACOperandKind.Variable) return null;
  if (
    (bin.dest as VariableOperand).name !== (bin.left as VariableOperand).name
  ) {
    return null;
  }
  if (!isNumericConstant(bin.right)) return null;
  const destKey = livenessKey(bin.dest);
  if (!destKey || destKey !== variableKey) return null;
  const step = (bin.right as ConstantOperand).value as number;
  if (!Number.isFinite(step)) return null;
  return { step: bin.operator === "-" ? -step : step };
};

const extractCondition = (
  instructions: TACInstruction[],
  start: number,
  end: number,
  condition: TACOperand,
): {
  variableKey: string;
  bound: number;
  operator: "<" | "<=";
} | null => {
  let conditionDef: BinaryOpInstruction | null = null;
  const conditionKey = livenessKey(condition);
  if (!conditionKey) return null;

  for (let i = end - 1; i >= start; i -= 1) {
    const inst = instructions[i];
    const def = getDefinedOperandForReuse(inst);
    if (!def) continue;
    if (livenessKey(def) !== conditionKey) continue;
    if (inst.kind !== TACInstructionKind.BinaryOp) return null;
    conditionDef = inst as BinaryOpInstruction;
    break;
  }

  if (!conditionDef) return null;
  if (conditionDef.operator !== "<" && conditionDef.operator !== "<=") {
    return null;
  }
  if (conditionDef.left.kind !== TACOperandKind.Variable) return null;
  if (!isNumericConstant(conditionDef.right)) return null;
  const variableKey = livenessKey(conditionDef.left);
  if (!variableKey) return null;
  const bound = (conditionDef.right as ConstantOperand).value as number;
  if (!Number.isFinite(bound)) return null;

  return {
    variableKey,
    bound,
    operator: conditionDef.operator as "<" | "<=",
  };
};

const findInitializer = (
  instructions: TACInstruction[],
  startIndex: number,
  variableKey: string,
): number | null => {
  for (let i = startIndex - 1; i >= 0; i -= 1) {
    const inst = instructions[i];
    if (inst.kind === TACInstructionKind.Label) break;
    if (
      inst.kind !== TACInstructionKind.Assignment &&
      inst.kind !== TACInstructionKind.Copy
    ) {
      continue;
    }
    const assign = inst as AssignmentInstruction;
    const destKey = livenessKey(assign.dest);
    if (destKey !== variableKey) continue;
    if (!isNumericConstant(assign.src)) return null;
    const value = (assign.src as ConstantOperand).value as number;
    if (!Number.isFinite(value)) return null;
    return value;
  }
  return null;
};

const isLoopBodySimple = (body: TACInstruction[]): boolean => {
  for (const inst of body) {
    if (
      inst.kind === TACInstructionKind.Label ||
      inst.kind === TACInstructionKind.ConditionalJump ||
      inst.kind === TACInstructionKind.UnconditionalJump ||
      inst.kind === TACInstructionKind.Return
    ) {
      return false;
    }
  }
  return true;
};

const computeTripCount = (
  init: number,
  bound: number,
  step: number,
  operator: "<" | "<=",
): number | null => {
  if (step === 0) return null;
  if (step < 0) return null;
  const diff = bound - init;
  if (operator === "<") {
    if (diff <= 0) return 0;
    return Math.ceil(diff / step);
  }
  if (diff < 0) return 0;
  return Math.floor(diff / step) + 1;
};

export const optimizeLoopStructures = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  if (instructions.length === 0) return instructions;

  const labelIndices = collectLabelIndices(instructions);
  const labelUses = collectLabelUses(instructions);
  const result: TACInstruction[] = [];

  let i = 0;
  while (i < instructions.length) {
    const inst = instructions[i];
    if (inst.kind !== TACInstructionKind.Label) {
      result.push(inst);
      i += 1;
      continue;
    }

    const startLabel = inst as LabelInstruction;
    if (startLabel.label.kind !== TACOperandKind.Label) {
      result.push(inst);
      i += 1;
      continue;
    }
    const startName = (startLabel.label as LabelOperand).name;

    let condJumpIndex = -1;
    for (let j = i + 1; j < instructions.length; j += 1) {
      const scan = instructions[j];
      if (scan.kind === TACInstructionKind.Label) break;
      if (scan.kind === TACInstructionKind.ConditionalJump) {
        condJumpIndex = j;
        break;
      }
    }
    if (condJumpIndex === -1) {
      result.push(inst);
      i += 1;
      continue;
    }

    const condJump = instructions[condJumpIndex] as ConditionalJumpInstruction;
    if (condJump.label.kind !== TACOperandKind.Label) {
      result.push(inst);
      i += 1;
      continue;
    }
    const endName = (condJump.label as LabelOperand).name;
    const endIndex = labelIndices.get(endName);
    if (endIndex === undefined) {
      result.push(inst);
      i += 1;
      continue;
    }

    const jumpBackIndex = endIndex - 1;
    if (jumpBackIndex <= condJumpIndex) {
      result.push(inst);
      i += 1;
      continue;
    }
    const jumpBack = instructions[jumpBackIndex];
    if (jumpBack.kind !== TACInstructionKind.UnconditionalJump) {
      result.push(inst);
      i += 1;
      continue;
    }
    const backLabel = (jumpBack as UnconditionalJumpInstruction).label;
    if (backLabel.kind !== TACOperandKind.Label) {
      result.push(inst);
      i += 1;
      continue;
    }
    const backName = (backLabel as LabelOperand).name;
    if (backName !== startName) {
      result.push(inst);
      i += 1;
      continue;
    }

    if ((labelUses.get(startName) ?? 0) !== 1) {
      result.push(inst);
      i += 1;
      continue;
    }
    if ((labelUses.get(endName) ?? 0) !== 1) {
      result.push(inst);
      i += 1;
      continue;
    }

    const conditionInfo = extractCondition(
      instructions,
      i + 1,
      condJumpIndex,
      condJump.condition,
    );
    if (!conditionInfo) {
      result.push(inst);
      i += 1;
      continue;
    }

    const initValue = findInitializer(
      instructions,
      i,
      conditionInfo.variableKey,
    );
    if (initValue === null) {
      result.push(inst);
      i += 1;
      continue;
    }

    const incrementInfo = isSimpleIncrement(
      instructions[jumpBackIndex - 1],
      conditionInfo.variableKey,
    );
    if (!incrementInfo) {
      result.push(inst);
      i += 1;
      continue;
    }

    const tripCount = computeTripCount(
      initValue,
      conditionInfo.bound,
      incrementInfo.step,
      conditionInfo.operator,
    );
    if (tripCount === null || tripCount <= 0 || tripCount > 3) {
      result.push(inst);
      i += 1;
      continue;
    }

    const header = instructions.slice(i + 1, condJumpIndex);
    if (!isLoopBodySimple(header)) {
      result.push(inst);
      i += 1;
      continue;
    }

    const bodyStart = condJumpIndex + 1;
    const bodyEnd = jumpBackIndex - 1;
    const body = instructions.slice(bodyStart, bodyEnd + 1);
    if (!isLoopBodySimple(body)) {
      result.push(inst);
      i += 1;
      continue;
    }

    for (let iter = 0; iter < tripCount; iter += 1) {
      result.push(...header, ...body);
    }

    i = endIndex + 1;
  }

  return result;
};

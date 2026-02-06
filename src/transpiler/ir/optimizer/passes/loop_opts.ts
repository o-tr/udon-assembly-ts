import {
  ArrayAccessInstruction,
  ArrayAssignmentInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  CastInstruction,
  type ConditionalJumpInstruction,
  CopyInstruction,
  type LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  PropertySetInstruction,
  ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnaryOpInstruction,
  type UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import type {
  ConstantOperand,
  LabelOperand,
  TACOperand,
  TemporaryOperand,
  VariableOperand,
} from "../../tac_operand.js";
import { createTemporary, TACOperandKind } from "../../tac_operand.js";
import {
  getDefinedOperandForReuse,
  getMaxTempId,
  rewriteOperands,
} from "../utils/instructions.js";
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
  // ConditionalJump is defined as ifFalse; this treats the condition as
  // the loop-continue predicate (see TACInstructionKind.ConditionalJump).
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

const cloneInstruction = (inst: TACInstruction): TACInstruction => {
  switch (inst.kind) {
    case TACInstructionKind.Assignment: {
      const a = inst as AssignmentInstruction;
      return new AssignmentInstruction(a.dest, a.src);
    }
    case TACInstructionKind.Copy: {
      const c = inst as CopyInstruction;
      return new CopyInstruction(c.dest, c.src);
    }
    case TACInstructionKind.Cast: {
      const c = inst as CastInstruction;
      return new CastInstruction(c.dest, c.src);
    }
    case TACInstructionKind.BinaryOp: {
      const b = inst as BinaryOpInstruction;
      return new BinaryOpInstruction(b.dest, b.left, b.operator, b.right);
    }
    case TACInstructionKind.UnaryOp: {
      const u = inst as UnaryOpInstruction;
      return new UnaryOpInstruction(u.dest, u.operator, u.operand);
    }
    case TACInstructionKind.Call: {
      const c = inst as CallInstruction;
      return new CallInstruction(c.dest, c.func, [...c.args], c.isTailCall);
    }
    case TACInstructionKind.MethodCall: {
      const m = inst as MethodCallInstruction;
      return new MethodCallInstruction(
        m.dest,
        m.object,
        m.method,
        [...m.args],
        m.isTailCall,
      );
    }
    case TACInstructionKind.PropertyGet: {
      const g = inst as PropertyGetInstruction;
      return new PropertyGetInstruction(g.dest, g.object, g.property);
    }
    case TACInstructionKind.PropertySet: {
      const s = inst as PropertySetInstruction;
      return new PropertySetInstruction(s.object, s.property, s.value);
    }
    case TACInstructionKind.ArrayAccess: {
      const a = inst as ArrayAccessInstruction;
      return new ArrayAccessInstruction(a.dest, a.array, a.index);
    }
    case TACInstructionKind.ArrayAssignment: {
      const a = inst as ArrayAssignmentInstruction;
      return new ArrayAssignmentInstruction(a.array, a.index, a.value);
    }
    case TACInstructionKind.Return: {
      const r = inst as ReturnInstruction;
      return new ReturnInstruction(r.value);
    }
    default:
      return inst;
  }
};

const collectTempDefs = (insts: TACInstruction[]): Set<number> => {
  const defs = new Set<number>();
  for (const inst of insts) {
    const def = getDefinedOperandForReuse(inst);
    if (def?.kind === TACOperandKind.Temporary) {
      defs.add((def as TemporaryOperand).id);
    }
  }
  return defs;
};

const remapTemp = (
  operand: TACOperand,
  map: Map<number, TemporaryOperand>,
  defIds: Set<number>,
  nextTempIdRef: { value: number },
): TACOperand => {
  if (operand.kind !== TACOperandKind.Temporary) return operand;
  const temp = operand as TemporaryOperand;
  if (!defIds.has(temp.id)) return operand;
  let mapped = map.get(temp.id);
  if (!mapped) {
    mapped = createTemporary(nextTempIdRef.value++, temp.type);
    map.set(temp.id, mapped);
  }
  return mapped;
};

const cloneWithTempMap = (
  insts: TACInstruction[],
  map: Map<number, TemporaryOperand>,
  defIds: Set<number>,
  nextTempIdRef: { value: number },
): TACInstruction[] => {
  return insts.map((inst) => {
    const cloned = cloneInstruction(inst);
    rewriteOperands(cloned, (op) => remapTemp(op, map, defIds, nextTempIdRef));
    return cloned;
  });
};

export const optimizeLoopStructures = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  if (instructions.length === 0) return instructions;

  const labelIndices = collectLabelIndices(instructions);
  const labelUses = collectLabelUses(instructions);
  const result: TACInstruction[] = [];
  let nextTempId = getMaxTempId(instructions) + 1;

  let i = 0;
  while (i < instructions.length) {
    const inst = instructions[i];
    const bail = (): void => {
      result.push(inst);
      i += 1;
    };
    if (inst.kind !== TACInstructionKind.Label) {
      bail();
      continue;
    }

    const startLabel = inst as LabelInstruction;
    if (startLabel.label.kind !== TACOperandKind.Label) {
      bail();
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
      bail();
      continue;
    }

    const condJump = instructions[condJumpIndex] as ConditionalJumpInstruction;
    if (condJump.label.kind !== TACOperandKind.Label) {
      bail();
      continue;
    }
    const endName = (condJump.label as LabelOperand).name;
    const endIndex = labelIndices.get(endName);
    if (endIndex === undefined) {
      bail();
      continue;
    }

    const jumpBackIndex = endIndex - 1;
    if (jumpBackIndex <= condJumpIndex) {
      bail();
      continue;
    }
    const jumpBack = instructions[jumpBackIndex];
    if (jumpBack.kind !== TACInstructionKind.UnconditionalJump) {
      bail();
      continue;
    }
    const backLabel = (jumpBack as UnconditionalJumpInstruction).label;
    if (backLabel.kind !== TACOperandKind.Label) {
      bail();
      continue;
    }
    const backName = (backLabel as LabelOperand).name;
    if (backName !== startName) {
      bail();
      continue;
    }

    if ((labelUses.get(startName) ?? 0) !== 1) {
      bail();
      continue;
    }
    if ((labelUses.get(endName) ?? 0) !== 1) {
      bail();
      continue;
    }

    const conditionInfo = extractCondition(
      instructions,
      i + 1,
      condJumpIndex,
      condJump.condition,
    );
    if (!conditionInfo) {
      bail();
      continue;
    }

    const initValue = findInitializer(
      instructions,
      i,
      conditionInfo.variableKey,
    );
    if (initValue === null) {
      bail();
      continue;
    }

    const incrementInfo = isSimpleIncrement(
      instructions[jumpBackIndex - 1],
      conditionInfo.variableKey,
    );
    if (!incrementInfo) {
      bail();
      continue;
    }

    const tripCount = computeTripCount(
      initValue,
      conditionInfo.bound,
      incrementInfo.step,
      conditionInfo.operator,
    );
    if (tripCount === null || tripCount <= 0 || tripCount > 3) {
      bail();
      continue;
    }

    const header = instructions.slice(i + 1, condJumpIndex);
    // exclude the condition computation from unrolled iterations: it's only
    // used by the conditional jump and not needed once the loop is unrolled.
    const condKey = livenessKey(condJump.condition);
    let condDefIndex = -1;
    if (condKey) {
      for (let k = i + 1; k < condJumpIndex; k += 1) {
        const def = getDefinedOperandForReuse(instructions[k]);
        if (def && livenessKey(def) === condKey) {
          condDefIndex = k;
          break;
        }
      }
    }
    // headerBeforeCondition are header instructions before the condition def
    const headerBeforeCondition =
      condDefIndex >= 0 ? instructions.slice(i + 1, condDefIndex) : header;
    if (condDefIndex >= 0) {
      const gapStart = condDefIndex + 1;
      const gapEnd = condJumpIndex - 1;
      if (gapStart <= gapEnd) {
        bail();
        continue;
      }
    }
    if (!isLoopBodySimple(headerBeforeCondition)) {
      bail();
      continue;
    }

    const bodyStart = condJumpIndex + 1;
    const incrementIndex = jumpBackIndex - 1;
    const body = instructions.slice(bodyStart, incrementIndex);
    if (!isLoopBodySimple(body)) {
      bail();
      continue;
    }

    const incrementInst = instructions[incrementIndex];

    const defIds = collectTempDefs([
      ...headerBeforeCondition,
      ...body,
      incrementInst,
    ]);
    const nextTempIdRef = { value: nextTempId };

    for (let iter = 0; iter < tripCount; iter += 1) {
      const tempMap = new Map<number, TemporaryOperand>();
      const clonedHeader = cloneWithTempMap(
        headerBeforeCondition,
        tempMap,
        defIds,
        nextTempIdRef,
      );
      const clonedBody = cloneWithTempMap(body, tempMap, defIds, nextTempIdRef);
      const [clonedIncrement] = cloneWithTempMap(
        [incrementInst],
        tempMap,
        defIds,
        nextTempIdRef,
      );
      result.push(...clonedHeader, ...clonedBody, clonedIncrement);
    }

    nextTempId = nextTempIdRef.value;

    i = endIndex + 1;
  }

  return result;
};

import {
  type ArrayAccessInstruction,
  type ArrayAssignmentInstruction,
  AssignmentInstruction,
  type BinaryOpInstruction,
  type CallInstruction,
  type CastInstruction,
  type ConditionalJumpInstruction,
  CopyInstruction,
  type LabelInstruction,
  type MethodCallInstruction,
  type PropertyGetInstruction,
  type PropertySetInstruction,
  type ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  type UnaryOpInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import type {
  ConstantOperand,
  LabelOperand,
  TACOperand,
  VariableOperand,
} from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import {
  getDefinedOperandForReuse,
  type InstWithDestSrc,
} from "../utils/instructions.js";
import { stringifyConstant } from "../utils/operands.js";
import { isTruthyConstant } from "./boolean_simplification.js";
import { getOperandType } from "./constant_folding.js";
import { resolveReachableSuccs } from "./jumps.js";
import { isCopyOnWriteCandidateType } from "./temp_reuse.js";

export type LatticeValue =
  | { kind: "unknown" }
  | { kind: "constant"; operand: ConstantOperand }
  | { kind: "copy"; operand: VariableOperand };

export const sccpAndPrune = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  const labelToBlock = new Map<string, number>();
  for (const block of cfg.blocks) {
    for (let i = block.start; i <= block.end; i++) {
      const inst = instructions[i];
      if (inst.kind !== TACInstructionKind.Label) continue;
      const labelInst = inst as LabelInstruction;
      if (labelInst.label.kind !== TACOperandKind.Label) continue;
      labelToBlock.set((labelInst.label as LabelOperand).name, block.id);
    }
  }

  const inMaps = new Map<number, Map<string, LatticeValue>>();
  const outMaps = new Map<number, Map<string, LatticeValue>>();
  for (const block of cfg.blocks) {
    inMaps.set(block.id, new Map());
    outMaps.set(block.id, new Map());
  }

  const reachable = new Set<number>();
  const queue: number[] = [];
  const inQueue = new Set<number>();
  const enqueue = (id: number): void => {
    if (!inQueue.has(id)) {
      inQueue.add(id);
      queue.push(id);
    }
  };

  reachable.add(0);
  enqueue(0);

  while (queue.length > 0) {
    const blockId = queue.shift() as number;
    inQueue.delete(blockId);
    const block = cfg.blocks[blockId];

    const predMaps = block.preds
      .filter((id) => reachable.has(id))
      .map((id) => outMaps.get(id) ?? new Map());
    const mergedIn = mergeLatticeMaps(predMaps);
    const currentIn = inMaps.get(blockId) ?? new Map();
    if (!latticeMapsEqual(currentIn, mergedIn)) {
      inMaps.set(blockId, mergedIn);
    }

    let working = new Map(mergedIn);
    for (let i = block.start; i <= block.end; i++) {
      working = transferLatticeMap(working, instructions[i]);
    }

    const currentOut = outMaps.get(blockId) ?? new Map();
    const outChanged = !latticeMapsEqual(currentOut, working);
    if (outChanged) {
      outMaps.set(blockId, working);
    }

    const succs = resolveReachableSuccs(
      block,
      instructions,
      labelToBlock,
      (operand) => resolveLatticeConstant(operand, working),
      cfg.blocks.length,
    );
    for (const succ of succs) {
      if (!reachable.has(succ)) {
        reachable.add(succ);
        enqueue(succ);
        continue;
      }
      if (outChanged) enqueue(succ);
    }
  }

  const result: TACInstruction[] = [];
  for (const block of cfg.blocks) {
    if (!reachable.has(block.id)) continue;
    let working = new Map(inMaps.get(block.id) ?? new Map());
    for (let i = block.start; i <= block.end; i++) {
      let inst = instructions[i];
      inst = replaceInstructionWithLatticeMap(inst, working);

      if (inst.kind === TACInstructionKind.ConditionalJump) {
        const condInst = inst as ConditionalJumpInstruction;
        const condConst = resolveLatticeConstant(condInst.condition, working);
        const truthy = condConst ? isTruthyConstant(condConst.value) : null;
        if (truthy === true) {
          result.push(new UnconditionalJumpInstruction(condInst.label));
        } else if (truthy === false) {
          // Always false; skip conditional jump (fallthrough).
        } else {
          result.push(inst);
        }
      } else {
        result.push(inst);
      }

      working = transferLatticeMap(working, inst);
    }
  }

  return result;
};

const mergeLatticeMaps = (
  predMaps: Array<Map<string, LatticeValue>>,
): Map<string, LatticeValue> => {
  const valid = predMaps.filter((map) => map !== undefined);
  if (valid.length === 0) return new Map();
  const [first, ...rest] = valid;
  const merged = new Map<string, LatticeValue>();
  for (const [key, value] of first.entries()) {
    let same = true;
    for (const map of rest) {
      const other = map.get(key);
      if (!other || !latticeValueEquals(value, other)) {
        same = false;
        break;
      }
    }
    if (same) merged.set(key, value);
  }
  return merged;
};

const latticeMapsEqual = (
  a: Map<string, LatticeValue>,
  b: Map<string, LatticeValue>,
): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a.entries()) {
    const other = b.get(key);
    if (!other || !latticeValueEquals(value, other)) return false;
  }
  return true;
};

const latticeValueEquals = (a: LatticeValue, b: LatticeValue): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "constant" && b.kind === "constant") {
    return (
      a.operand.type.udonType === b.operand.type.udonType &&
      stringifyConstant(a.operand.value) === stringifyConstant(b.operand.value)
    );
  }
  if (a.kind === "copy" && b.kind === "copy") {
    return a.operand.name === b.operand.name;
  }
  if (a.kind === "unknown" && b.kind === "unknown") return true;
  return false;
};

const transferLatticeMap = (
  current: Map<string, LatticeValue>,
  inst: TACInstruction,
): Map<string, LatticeValue> => {
  const next = new Map(current);
  if (
    inst.kind === TACInstructionKind.Assignment ||
    inst.kind === TACInstructionKind.Copy
  ) {
    const { dest, src } = inst as unknown as InstWithDestSrc;
    if (dest.kind === TACOperandKind.Variable) {
      const destName = (dest as VariableOperand).name;
      const resolvedConst = resolveLatticeConstant(src, next);
      if (resolvedConst) {
        next.set(destName, { kind: "constant", operand: resolvedConst });
      } else if (src.kind === TACOperandKind.Variable) {
        next.set(destName, { kind: "copy", operand: src as VariableOperand });
      } else {
        next.delete(destName);
      }
    }
    return next;
  }

  if (inst.kind === TACInstructionKind.PropertySet) {
    const set = inst as PropertySetInstruction;
    if (set.object.kind === TACOperandKind.Variable) {
      next.delete((set.object as VariableOperand).name);
    }
    return next;
  }

  if (inst.kind === TACInstructionKind.ArrayAssignment) {
    const assign = inst as ArrayAssignmentInstruction;
    if (assign.array.kind === TACOperandKind.Variable) {
      next.delete((assign.array as VariableOperand).name);
    }
    return next;
  }

  if (inst.kind === TACInstructionKind.MethodCall) {
    const call = inst as MethodCallInstruction;
    if (
      call.object.kind === TACOperandKind.Variable &&
      isCopyOnWriteCandidateType(getOperandType(call.object))
    ) {
      next.delete((call.object as VariableOperand).name);
    }
    // fall through to clear any defined variable via getDefinedOperandForReuse
  }

  const defined = getDefinedOperandForReuse(inst);
  if (defined && defined.kind === TACOperandKind.Variable) {
    next.delete((defined as VariableOperand).name);
  }
  return next;
};

export const resolveLatticeConstant = (
  operand: TACOperand,
  map: Map<string, LatticeValue>,
): ConstantOperand | null => {
  if (operand.kind === TACOperandKind.Constant) {
    return operand as ConstantOperand;
  }
  if (operand.kind !== TACOperandKind.Variable) return null;

  const visited = new Set<string>();
  let current = operand as VariableOperand;
  while (!visited.has(current.name)) {
    visited.add(current.name);
    const info = map.get(current.name);
    if (!info || info.kind === "unknown") return null;
    if (info.kind === "constant") return info.operand;
    if (info.kind === "copy") {
      current = info.operand;
    }
  }
  return null;
};

const resolveLatticeOperand = (
  operand: TACOperand,
  map: Map<string, LatticeValue>,
): TACOperand => {
  if (operand.kind !== TACOperandKind.Variable) return operand;
  const visited = new Set<string>();
  let current = operand as VariableOperand;
  while (!visited.has(current.name)) {
    visited.add(current.name);
    const info = map.get(current.name);
    if (!info || info.kind === "unknown") return current;
    if (info.kind === "constant") return info.operand;
    if (info.kind === "copy") {
      current = info.operand;
    }
  }
  return current;
};

const replaceInstructionWithLatticeMap = (
  inst: TACInstruction,
  map: Map<string, LatticeValue>,
): TACInstruction => {
  const replace = (operand: TACOperand): TACOperand =>
    resolveLatticeOperand(operand, map);

  if (inst.kind === TACInstructionKind.BinaryOp) {
    const bin = inst as BinaryOpInstruction;
    const left = replace(bin.left);
    const right = replace(bin.right);
    if (left !== bin.left || right !== bin.right) {
      return new (bin.constructor as typeof BinaryOpInstruction)(
        bin.dest,
        left,
        bin.operator,
        right,
      );
    }
  }

  if (inst.kind === TACInstructionKind.UnaryOp) {
    const un = inst as UnaryOpInstruction;
    const operand = replace(un.operand);
    if (operand !== un.operand) {
      return new (un.constructor as typeof UnaryOpInstruction)(
        un.dest,
        un.operator,
        operand,
      );
    }
  }

  if (
    inst.kind === TACInstructionKind.Assignment ||
    inst.kind === TACInstructionKind.Copy
  ) {
    const { dest, src } = inst as unknown as InstWithDestSrc;
    const resolved = replace(src);
    if (resolved !== src) {
      if (inst.kind === TACInstructionKind.Copy) {
        return new CopyInstruction(dest, resolved);
      }
      return new AssignmentInstruction(dest, resolved);
    }
  }

  if (inst.kind === TACInstructionKind.Cast) {
    const castInst = inst as CastInstruction;
    const resolved = replace(castInst.src);
    if (resolved !== castInst.src) {
      return new (castInst.constructor as typeof CastInstruction)(
        castInst.dest,
        resolved,
      );
    }
  }

  if (inst.kind === TACInstructionKind.ConditionalJump) {
    const cond = inst as ConditionalJumpInstruction;
    const condition = replace(cond.condition);
    if (condition !== cond.condition) {
      return new (cond.constructor as typeof ConditionalJumpInstruction)(
        condition,
        cond.label,
      );
    }
  }

  if (inst.kind === TACInstructionKind.Call) {
    const call = inst as CallInstruction;
    const args = call.args.map((arg) => replace(arg));
    if (args.some((arg, idx) => arg !== call.args[idx])) {
      return new (call.constructor as typeof CallInstruction)(
        call.dest,
        call.func,
        args,
      );
    }
  }

  if (inst.kind === TACInstructionKind.MethodCall) {
    const call = inst as MethodCallInstruction;
    const object = replace(call.object);
    const args = call.args.map((arg) => replace(arg));
    if (
      object !== call.object ||
      args.some((arg, idx) => arg !== call.args[idx])
    ) {
      return new (call.constructor as typeof MethodCallInstruction)(
        call.dest,
        object,
        call.method,
        args,
      );
    }
  }

  if (inst.kind === TACInstructionKind.PropertyGet) {
    const get = inst as PropertyGetInstruction;
    const object = replace(get.object);
    if (object !== get.object) {
      return new (get.constructor as typeof PropertyGetInstruction)(
        get.dest,
        object,
        get.property,
      );
    }
  }

  if (inst.kind === TACInstructionKind.PropertySet) {
    const set = inst as PropertySetInstruction;
    const object = replace(set.object);
    const value = replace(set.value);
    if (object !== set.object || value !== set.value) {
      return new (set.constructor as typeof PropertySetInstruction)(
        object,
        set.property,
        value,
      );
    }
  }

  if (inst.kind === TACInstructionKind.Return) {
    const ret = inst as ReturnInstruction;
    if (ret.value) {
      const value = replace(ret.value);
      if (value !== ret.value) {
        return new (ret.constructor as typeof ReturnInstruction)(
          value,
          ret.returnVarName,
        );
      }
    }
  }

  if (inst.kind === TACInstructionKind.ArrayAccess) {
    const access = inst as ArrayAccessInstruction;
    const array = replace(access.array);
    const index = replace(access.index);
    if (array !== access.array || index !== access.index) {
      return new (access.constructor as typeof ArrayAccessInstruction)(
        access.dest,
        array,
        index,
      );
    }
  }

  if (inst.kind === TACInstructionKind.ArrayAssignment) {
    const assign = inst as ArrayAssignmentInstruction;
    const array = replace(assign.array);
    const index = replace(assign.index);
    const value = replace(assign.value);
    if (
      array !== assign.array ||
      index !== assign.index ||
      value !== assign.value
    ) {
      return new (assign.constructor as typeof ArrayAssignmentInstruction)(
        array,
        index,
        value,
      );
    }
  }

  return inst;
};

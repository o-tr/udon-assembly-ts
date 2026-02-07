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
  | { kind: "overdefined" }
  | { kind: "constant"; operand: ConstantOperand }
  | { kind: "copy"; operand: VariableOperand };

export const sccpAndPrune = (
  instructions: TACInstruction[],
  exposedLabels?: Set<string>,
  options?: { maxWorklistIterations?: number; onLimitReached?: "markAllReachable" | "break" | "warn" },
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
  let qHead = 0;
  const inQueue = new Set<number>();
  const enqueue = (id: number): void => {
    if (!inQueue.has(id)) {
      inQueue.add(id);
      queue.push(id);
    }
  };

  // entry block always reachable
  reachable.add(0);
  enqueue(0);

  // Also mark explicitly-exposed labels reachable so they won't be pruned
  if (exposedLabels && exposedLabels.size > 0) {
    for (const lbl of exposedLabels) {
      const b = labelToBlock.get(lbl);
      if (b !== undefined && !reachable.has(b)) {
        reachable.add(b);
        enqueue(b);
      }
    }
  }

  const maxIterations =
    options?.maxWorklistIterations ?? Math.max(1000, cfg.blocks.length * 1000);
  const onLimit = options?.onLimitReached ?? "markAllReachable";
  let workIterations = 0;

  const processedOnce = new Set<number>();

  while (qHead < queue.length) {
    const blockId = queue[qHead++] as number;
    inQueue.delete(blockId);
    const block = cfg.blocks[blockId];

    const firstTime = !processedOnce.has(blockId);
    if (firstTime) processedOnce.add(blockId);

    const predMaps = block.preds
      .filter((id) => reachable.has(id))
      .map((id) => outMaps.get(id) ?? new Map());
    const mergedIn = mergeLatticeMaps(predMaps);
    const currentIn = inMaps.get(blockId) ?? new Map();
    const inChanged = !latticeMapsEqual(currentIn, mergedIn);

    // Transfer is deterministic: if input unchanged and already processed, skip
    if (!firstTime && !inChanged) {
      continue;
    }

    // Count only iterations that perform actual work (after skip check)
    if (++workIterations > maxIterations) {
      // try {
      //   console.warn(
      //     `sccpAndPrune: reached maxWorklistIterations=${maxIterations}; aborting early`,
      //   );
      // } catch (e) {
      //   /* ignore */
      // }
      // if (onLimit === "markAllReachable") {
      //   for (const b of cfg.blocks) reachable.add(b.id);
      // }
      // break;
    }
    if (workIterations % 5000 === 0) {
      // keep occasional progress logs for long runs
      try {
        console.log(`sccp iter: ${workIterations}/${maxIterations}`);
      } catch (e) {
        /* ignore */
      }
    }

    if (inChanged) {
      inMaps.set(blockId, mergedIn);
    }

    const working = new Map(mergedIn);
    for (let i = block.start; i <= block.end; i++) {
      transferLatticeMapMut(working, instructions[i]);
    }

    const currentOut = outMaps.get(blockId) ?? new Map();
    const outChanged = !latticeMapsEqual(currentOut, working);
    if (outChanged) {
      outMaps.set(blockId, working);
    }

    if (firstTime || outChanged) {
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
  }

  const result: TACInstruction[] = [];
  for (const block of cfg.blocks) {
    if (!reachable.has(block.id)) continue;
    const working = new Map(inMaps.get(block.id) ?? new Map());
    for (let i = block.start; i <= block.end; i++) {
      let inst = instructions[i];
      inst = replaceInstructionWithLatticeMap(inst, working);

      if (inst.kind === TACInstructionKind.ConditionalJump) {
        const condInst = inst as ConditionalJumpInstruction;
        const condConst = resolveLatticeConstant(condInst.condition, working);
        const truthy = condConst ? isTruthyConstant(condConst.value) : null;
        if (truthy === false) {
          result.push(new UnconditionalJumpInstruction(condInst.label));
        } else if (truthy === true) {
          // Always true; skip conditional jump (fallthrough).
        } else {
          result.push(inst);
        }
      } else {
        result.push(inst);
      }

      transferLatticeMapMut(working, inst);
    }
  }

  return result;
};

const mergeLatticeMaps = (
  predMaps: Array<Map<string, LatticeValue>>,
): Map<string, LatticeValue> => {
  const valid = predMaps.filter((map) => map !== undefined);
  if (valid.length === 0) return new Map();
  if (valid.length === 1) return new Map(valid[0]);

  const keys = new Set<string>();
  for (const map of valid) {
    for (const key of map.keys()) keys.add(key);
  }

  const merged = new Map<string, LatticeValue>();
  for (const key of keys) {
    let acc: LatticeValue = { kind: "unknown" };
    for (const map of valid) {
      acc = mergeLatticeValues(acc, map.get(key) ?? { kind: "unknown" });
    }
    if (acc.kind !== "unknown") merged.set(key, acc);
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
  if (a.kind === "overdefined" && b.kind === "overdefined") return true;
  if (a.kind === "unknown" && b.kind === "unknown") return true;
  return false;
};

const mergeLatticeValues = (a: LatticeValue, b: LatticeValue): LatticeValue => {
  if (a.kind === "unknown") return b;
  if (b.kind === "unknown") return a;
  if (a.kind === "overdefined" || b.kind === "overdefined") {
    return { kind: "overdefined" };
  }
  if (a.kind === "constant" && b.kind === "constant") {
    return latticeValueEquals(a, b) ? a : { kind: "overdefined" };
  }
  if (a.kind === "copy" && b.kind === "copy") {
    return latticeValueEquals(a, b) ? a : { kind: "overdefined" };
  }
  return { kind: "overdefined" };
};

const transferLatticeMapMut = (
  map: Map<string, LatticeValue>,
  inst: TACInstruction,
): void => {
  if (
    inst.kind === TACInstructionKind.Assignment ||
    inst.kind === TACInstructionKind.Copy
  ) {
    const { dest, src } = inst as unknown as InstWithDestSrc;
    if (dest.kind === TACOperandKind.Variable) {
      const destName = (dest as VariableOperand).name;
      const resolvedConst = resolveLatticeConstant(src, map);
      if (resolvedConst) {
        map.set(destName, { kind: "constant", operand: resolvedConst });
      } else if (src.kind === TACOperandKind.Variable) {
        const srcVar = src as VariableOperand;
        const srcInfo = map.get(srcVar.name);
        if (srcInfo?.kind === "overdefined") {
          map.set(destName, { kind: "overdefined" });
          return;
        }
        // Check if adding dest → copy(src) would create a cycle
        let isCycle = false;
        const visited = new Set<string>();
        let cur: VariableOperand | null = srcVar;
        while (cur && !visited.has(cur.name)) {
          if (cur.name === destName) {
            isCycle = true;
            break;
          }
          visited.add(cur.name);
          const info = map.get(cur.name);
          if (!info || info.kind !== "copy") break;
          cur = info.operand;
        }
        if (isCycle) {
          map.set(destName, { kind: "overdefined" });
        } else {
          map.set(destName, { kind: "copy", operand: srcVar });
        }
      } else {
        map.set(destName, { kind: "overdefined" });
      }
    }
    return;
  }

  if (inst.kind === TACInstructionKind.PropertySet) {
    const set = inst as PropertySetInstruction;
    if (set.object.kind === TACOperandKind.Variable) {
      map.set((set.object as VariableOperand).name, { kind: "overdefined" });
    }
    return;
  }

  if (inst.kind === TACInstructionKind.ArrayAssignment) {
    const assign = inst as ArrayAssignmentInstruction;
    if (assign.array.kind === TACOperandKind.Variable) {
      map.set((assign.array as VariableOperand).name, { kind: "overdefined" });
    }
    return;
  }

  if (inst.kind === TACInstructionKind.MethodCall) {
    const call = inst as MethodCallInstruction;
    if (
      call.object.kind === TACOperandKind.Variable &&
      isCopyOnWriteCandidateType(getOperandType(call.object))
    ) {
      map.set((call.object as VariableOperand).name, { kind: "overdefined" });
    }
    // fall through to clear any defined variable via getDefinedOperandForReuse
  }

  const defined = getDefinedOperandForReuse(inst);
  if (defined && defined.kind === TACOperandKind.Variable) {
    map.set((defined as VariableOperand).name, { kind: "overdefined" });
  }
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
    if (info.kind === "overdefined") return null;
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
    if (info.kind === "overdefined") return current;
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

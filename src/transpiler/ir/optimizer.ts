/**
 * TAC optimizer with various optimization passes
 */

import type { TypeSymbol } from "../frontend/type_symbols.js";
import { PrimitiveTypes } from "../frontend/type_symbols.js";
import {
  type ArrayAccessInstruction,
  type ArrayAssignmentInstruction,
  AssignmentInstruction,
  BinaryOpInstruction,
  type CallInstruction,
  CastInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  type LabelInstruction,
  type MethodCallInstruction,
  type PropertyGetInstruction,
  type PropertySetInstruction,
  type ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnaryOpInstruction,
  UnconditionalJumpInstruction,
} from "./tac_instruction.js";
import {
  type ConstantOperand,
  type ConstantValue,
  createConstant,
  createLabel,
  createTemporary,
  type LabelOperand,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
} from "./tac_operand.js";

type InstWithDestSrc = { dest: TACOperand; src: TACOperand };
type InstWithDest = { dest: TACOperand };
type ValueInfo =
  | { kind: "constant"; operand: ConstantOperand }
  | { kind: "copy"; operand: TACOperand };

type LatticeValue =
  | { kind: "unknown" }
  | { kind: "constant"; operand: ConstantOperand }
  | { kind: "copy"; operand: VariableOperand };

type BasicBlock = {
  id: number;
  start: number;
  end: number;
  preds: number[];
  succs: number[];
};

type ExprValue = { operandKey: string; operand: TACOperand };

/**
 * TAC optimizer
 */
export class TACOptimizer {
  private static readonly pureExternEvaluators = new Map<
    string,
    { arity: number; eval: (args: number[]) => number }
  >([
    [
      "UnityEngineMathf.__Abs__SystemSingle__SystemSingle",
      { arity: 1, eval: ([a]) => Math.abs(a) },
    ],
    [
      "UnityEngineMathf.__Ceil__SystemSingle__SystemSingle",
      { arity: 1, eval: ([a]) => Math.ceil(a) },
    ],
    [
      "UnityEngineMathf.__CeilToInt__SystemSingle__SystemInt32",
      { arity: 1, eval: ([a]) => Math.ceil(a) },
    ],
    [
      "UnityEngineMathf.__Clamp__SystemSingle_SystemSingle_SystemSingle__SystemSingle",
      {
        arity: 3,
        eval: ([v, min, max]) => Math.min(Math.max(v, min), max),
      },
    ],
    [
      "UnityEngineMathf.__Clamp01__SystemSingle__SystemSingle",
      { arity: 1, eval: ([v]) => Math.min(Math.max(v, 0), 1) },
    ],
    [
      "UnityEngineMathf.__Floor__SystemSingle__SystemSingle",
      { arity: 1, eval: ([a]) => Math.floor(a) },
    ],
    [
      "UnityEngineMathf.__FloorToInt__SystemSingle__SystemInt32",
      { arity: 1, eval: ([a]) => Math.floor(a) },
    ],
    [
      "UnityEngineMathf.__Lerp__SystemSingle_SystemSingle_SystemSingle__SystemSingle",
      { arity: 3, eval: ([a, b, t]) => a + (b - a) * t },
    ],
    [
      "UnityEngineMathf.__Max__SystemSingle_SystemSingle__SystemSingle",
      { arity: 2, eval: ([a, b]) => Math.max(a, b) },
    ],
    [
      "UnityEngineMathf.__Min__SystemSingle_SystemSingle__SystemSingle",
      { arity: 2, eval: ([a, b]) => Math.min(a, b) },
    ],
    [
      "UnityEngineMathf.__Pow__SystemSingle_SystemSingle__SystemSingle",
      { arity: 2, eval: ([a, b]) => Math.pow(a, b) },
    ],
    [
      "UnityEngineMathf.__Round__SystemSingle__SystemSingle",
      { arity: 1, eval: ([a]) => Math.round(a) },
    ],
    [
      "UnityEngineMathf.__RoundToInt__SystemSingle__SystemInt32",
      { arity: 1, eval: ([a]) => Math.round(a) },
    ],
    [
      "UnityEngineMathf.__Sin__SystemSingle__SystemSingle",
      { arity: 1, eval: ([a]) => Math.sin(a) },
    ],
    [
      "UnityEngineMathf.__Cos__SystemSingle__SystemSingle",
      { arity: 1, eval: ([a]) => Math.cos(a) },
    ],
    [
      "UnityEngineMathf.__Sqrt__SystemSingle__SystemSingle",
      { arity: 1, eval: ([a]) => Math.sqrt(a) },
    ],
    [
      "UnityEngineMathf.__Tan__SystemSingle__SystemSingle",
      { arity: 1, eval: ([a]) => Math.tan(a) },
    ],
  ]);

  /**
   * Apply all optimization passes
   */
  optimize(instructions: TACInstruction[]): TACInstruction[] {
    let optimized = instructions;

    // Apply constant folding
    optimized = this.constantFolding(optimized);

    // Apply SCCP and prune unreachable blocks
    optimized = this.sccpAndPrune(optimized);

    // Apply boolean simplifications
    optimized = this.booleanSimplification(optimized);

    // Apply algebraic simplifications and redundant cast removal
    optimized = this.algebraicSimplification(optimized);

    // Apply global value numbering / CSE across blocks
    optimized = this.globalValueNumbering(optimized);

    // Eliminate single-use temporaries inside basic blocks
    optimized = this.eliminateSingleUseTemporaries(optimized);

    // Remove no-op copies/assignments
    optimized = this.eliminateNoopCopies(optimized);

    // Remove dead stores using CFG liveness
    optimized = this.eliminateDeadStoresCFG(optimized);

    // Apply dead code elimination
    optimized = this.deadCodeElimination(optimized);

    // Remove redundant jumps and thread jump chains
    optimized = this.simplifyJumps(optimized);

    // Hoist loop-invariant code
    optimized = this.performLICM(optimized);

    // Optimize simple induction variables
    optimized = this.optimizeInductionVariables(optimized);

    // Remove unused temporary computations
    optimized = this.eliminateDeadTemporaries(optimized);

    // Apply copy-on-write temporary reuse to reduce heap usage
    optimized = this.copyOnWriteTemporaries(optimized);

    // Reuse temporary variables to reduce heap usage
    optimized = this.reuseTemporaries(optimized);

    // Reuse local variables when lifetimes do not overlap
    optimized = this.reuseLocalVariables(optimized);

    return optimized;
  }

  private sccpAndPrune(instructions: TACInstruction[]): TACInstruction[] {
    const cfg = this.buildCFG(instructions);
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
      const mergedIn = this.mergeLatticeMaps(predMaps);
      const currentIn = inMaps.get(blockId) ?? new Map();
      if (!this.latticeMapsEqual(currentIn, mergedIn)) {
        inMaps.set(blockId, mergedIn);
      }

      let working = new Map(mergedIn);
      for (let i = block.start; i <= block.end; i++) {
        working = this.transferLatticeMap(working, instructions[i]);
      }

      const currentOut = outMaps.get(blockId) ?? new Map();
      const outChanged = !this.latticeMapsEqual(currentOut, working);
      if (outChanged) {
        outMaps.set(blockId, working);
      }

      const succs = this.resolveReachableSuccs(
        block,
        instructions,
        labelToBlock,
        working,
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
        inst = this.replaceInstructionWithLatticeMap(inst, working);

        if (inst.kind === TACInstructionKind.ConditionalJump) {
          const condInst = inst as ConditionalJumpInstruction;
          const condConst = this.resolveLatticeConstant(
            condInst.condition,
            working,
          );
          const truthy = condConst
            ? this.isTruthyConstant(condConst.value)
            : null;
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

        working = this.transferLatticeMap(working, inst);
      }
    }

    return result;
  }

  private booleanSimplification(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const result: TACInstruction[] = [];

    for (const inst of instructions) {
      if (inst.kind !== TACInstructionKind.BinaryOp) {
        result.push(inst);
        continue;
      }

      const bin = inst as BinaryOpInstruction;
      const destType = this.getOperandType(bin.dest);
      if (destType.udonType !== "Boolean") {
        result.push(inst);
        continue;
      }

      const leftConst = this.getBooleanConstant(bin.left);
      const rightConst = this.getBooleanConstant(bin.right);

      if (bin.operator === "&&") {
        if (leftConst !== null) {
          if (!leftConst) {
            result.push(
              new AssignmentInstruction(
                bin.dest,
                createConstant(false, destType),
              ),
            );
          } else {
            result.push(new AssignmentInstruction(bin.dest, bin.right));
          }
          continue;
        }
        if (rightConst !== null) {
          if (!rightConst) {
            result.push(
              new AssignmentInstruction(
                bin.dest,
                createConstant(false, destType),
              ),
            );
          } else {
            result.push(new AssignmentInstruction(bin.dest, bin.left));
          }
          continue;
        }
      }

      if (bin.operator === "||") {
        if (leftConst !== null) {
          if (leftConst) {
            result.push(
              new AssignmentInstruction(
                bin.dest,
                createConstant(true, destType),
              ),
            );
          } else {
            result.push(new AssignmentInstruction(bin.dest, bin.right));
          }
          continue;
        }
        if (rightConst !== null) {
          if (rightConst) {
            result.push(
              new AssignmentInstruction(
                bin.dest,
                createConstant(true, destType),
              ),
            );
          } else {
            result.push(new AssignmentInstruction(bin.dest, bin.left));
          }
          continue;
        }
      }

      if (bin.operator === "==" || bin.operator === "!=") {
        const constantSide =
          rightConst !== null
            ? { constant: rightConst, operand: bin.left }
            : leftConst !== null
              ? { constant: leftConst, operand: bin.right }
              : null;
        if (constantSide) {
          const { constant, operand } = constantSide;
          const shouldNegate =
            (bin.operator === "==" && !constant) ||
            (bin.operator === "!=" && constant);
          if (shouldNegate) {
            result.push(new UnaryOpInstruction(bin.dest, "!", operand));
          } else {
            result.push(new AssignmentInstruction(bin.dest, operand));
          }
          continue;
        }
      }

      result.push(inst);
    }

    return result;
  }

  private eliminateDeadStoresCFG(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const cfg = this.buildCFG(instructions);
    if (cfg.blocks.length === 0) return instructions;

    const useMap = new Map<number, Set<string>>();
    const defMap = new Map<number, Set<string>>();

    for (const block of cfg.blocks) {
      const use = new Set<string>();
      const def = new Set<string>();
      for (let i = block.start; i <= block.end; i++) {
        const inst = instructions[i];
        for (const op of this.getUsedOperandsForReuse(inst)) {
          const key = this.livenessKey(op);
          if (!key) continue;
          if (!def.has(key)) {
            use.add(key);
          }
        }
        const defined = this.getDefinedOperandForReuse(inst);
        const defKey = this.livenessKey(defined);
        if (defKey) {
          def.add(defKey);
        }
      }
      useMap.set(block.id, use);
      defMap.set(block.id, def);
    }

    const liveIn = new Map<number, Set<string>>();
    const liveOut = new Map<number, Set<string>>();
    for (const block of cfg.blocks) {
      liveIn.set(block.id, new Set());
      liveOut.set(block.id, new Set());
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const block of cfg.blocks.slice().reverse()) {
        const out = new Set<string>();
        for (const succ of block.succs) {
          const succIn = liveIn.get(succ) ?? new Set();
          for (const key of succIn) out.add(key);
        }

        const use = useMap.get(block.id) ?? new Set();
        const def = defMap.get(block.id) ?? new Set();
        const inSet = new Set<string>(use);
        for (const key of out) {
          if (!def.has(key)) inSet.add(key);
        }

        const prevOut = liveOut.get(block.id) ?? new Set();
        const prevIn = liveIn.get(block.id) ?? new Set();
        if (!this.stringSetEqual(prevOut, out)) {
          liveOut.set(block.id, out);
          changed = true;
        }
        if (!this.stringSetEqual(prevIn, inSet)) {
          liveIn.set(block.id, inSet);
          changed = true;
        }
      }
    }

    const result: TACInstruction[] = [];
    for (const block of cfg.blocks) {
      const live = new Set(liveOut.get(block.id) ?? new Set());
      const kept: TACInstruction[] = [];
      for (let i = block.end; i >= block.start; i--) {
        const inst = instructions[i];
        const defOp = this.getDefinedOperandForReuse(inst);
        const defKey = this.livenessKey(defOp);
        const uses = this.getUsedOperandsForReuse(inst)
          .map((op) => this.livenessKey(op))
          .filter((key): key is string => Boolean(key));

        if (this.isPureProducer(inst) && defKey && !live.has(defKey)) {
          continue;
        }

        if (defKey) {
          live.delete(defKey);
        }
        for (const key of uses) {
          live.add(key);
        }
        kept.push(inst);
      }
      kept.reverse();
      result.push(...kept);
    }

    return result;
  }

  private globalValueNumbering(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const cfg = this.buildCFG(instructions);
    if (cfg.blocks.length === 0) return instructions;

    const inMaps = new Map<number, Map<string, ExprValue>>();
    const outMaps = new Map<number, Map<string, ExprValue>>();

    for (const block of cfg.blocks) {
      inMaps.set(block.id, new Map());
      outMaps.set(block.id, new Map());
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const block of cfg.blocks) {
        const predMaps = block.preds.map((id) => outMaps.get(id) ?? new Map());
        const mergedIn = this.intersectExpressionMaps(predMaps);
        const currentIn = inMaps.get(block.id) ?? new Map();
        if (!this.exprMapsEqual(currentIn, mergedIn)) {
          inMaps.set(block.id, mergedIn);
          changed = true;
        }

        const simulated = this.simulateExpressionMap(
          mergedIn,
          instructions,
          block.start,
          block.end,
        );
        const currentOut = outMaps.get(block.id) ?? new Map();
        if (!this.exprMapsEqual(currentOut, simulated)) {
          outMaps.set(block.id, simulated);
          changed = true;
        }
      }
    }

    const result: TACInstruction[] = [];
    for (const block of cfg.blocks) {
      let working = new Map(inMaps.get(block.id) ?? new Map());
      for (let i = block.start; i <= block.end; i++) {
        let inst = instructions[i];
        const defined = this.getDefinedOperandForReuse(inst);
        const defKey = this.gvnOperandKey(defined);
        if (defKey) {
          this.killExpressionsUsingOperand(working, defKey);
        }

        if (inst.kind === TACInstructionKind.BinaryOp) {
          const bin = inst as BinaryOpInstruction;
          const exprKey = this.binaryExprKey(bin);
          const existing = working.get(exprKey);
          if (
            existing &&
            existing.operandKey !== this.operandKey(bin.dest) &&
            this.sameUdonType(existing.operand, bin.dest)
          ) {
            inst = new CopyInstruction(bin.dest, existing.operand);
          }
          result.push(inst);
          working.set(exprKey, {
            operandKey: this.operandKey(bin.dest),
            operand: bin.dest,
          });
          continue;
        }

        if (inst.kind === TACInstructionKind.UnaryOp) {
          const un = inst as UnaryOpInstruction;
          const exprKey = this.unaryExprKey(un);
          const existing = working.get(exprKey);
          if (
            existing &&
            existing.operandKey !== this.operandKey(un.dest) &&
            this.sameUdonType(existing.operand, un.dest)
          ) {
            inst = new CopyInstruction(un.dest, existing.operand);
          }
          result.push(inst);
          working.set(exprKey, {
            operandKey: this.operandKey(un.dest),
            operand: un.dest,
          });
          continue;
        }

        if (inst.kind === TACInstructionKind.Cast) {
          const castInst = inst as CastInstruction;
          const exprKey = this.castExprKey(castInst);
          const existing = working.get(exprKey);
          if (
            existing &&
            existing.operandKey !== this.operandKey(castInst.dest) &&
            this.sameUdonType(existing.operand, castInst.dest)
          ) {
            inst = new CopyInstruction(castInst.dest, existing.operand);
          }
          result.push(inst);
          working.set(exprKey, {
            operandKey: this.operandKey(castInst.dest),
            operand: castInst.dest,
          });
          continue;
        }

        result.push(inst);
      }
    }

    return result;
  }

  private computeDominators(
    cfg: { blocks: BasicBlock[] },
  ): Map<number, Set<number>> {
    const dom = new Map<number, Set<number>>();
    const all = new Set(cfg.blocks.map((block) => block.id));

    for (const block of cfg.blocks) {
      if (block.id === 0) {
        dom.set(block.id, new Set([block.id]));
      } else {
        dom.set(block.id, new Set(all));
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const block of cfg.blocks) {
        if (block.id === 0) continue;
        const preds = block.preds;
        if (preds.length === 0) continue;
        let intersection = new Set(dom.get(preds[0]) ?? new Set());
        for (let i = 1; i < preds.length; i++) {
          const predDom = dom.get(preds[i]) ?? new Set();
          intersection = new Set(
            Array.from(intersection).filter((id) => predDom.has(id)),
          );
        }
        intersection.add(block.id);
        const current = dom.get(block.id) ?? new Set();
        if (!this.numberSetEqual(current, intersection)) {
          dom.set(block.id, intersection);
          changed = true;
        }
      }
    }

    return dom;
  }

  private performLICM(instructions: TACInstruction[]): TACInstruction[] {
    const cfg = this.buildCFG(instructions);
    if (cfg.blocks.length === 0) return instructions;

    const loops = this.collectLoops(cfg);
    if (loops.length === 0) return instructions;

    const hoistMap = new Map<number, TACInstruction[]>();
    const hoistIndices = new Set<number>();

    for (const loop of loops) {
      const loopBlocks = loop.blocks;
      const preheader = cfg.blocks[loop.preheaderId];
      const preheaderInsert = this.preheaderInsertIndex(preheader, instructions);

      const loopDefKeys = new Set<string>();
      const defCounts = new Map<string, number>();
      const loopIndices: number[] = [];

      for (const blockId of loopBlocks) {
        const block = cfg.blocks[blockId];
        for (let i = block.start; i <= block.end; i++) {
          loopIndices.push(i);
          const defOp = this.getDefinedOperandForReuse(instructions[i]);
          const defKey = this.livenessKey(defOp);
          if (defKey) {
            loopDefKeys.add(defKey);
            defCounts.set(defKey, (defCounts.get(defKey) ?? 0) + 1);
          }
        }
      }

      const loopIndexSet = new Set(loopIndices);
      const useBeforeDef = new Map<string, number>();
      for (const index of loopIndices) {
        const inst = instructions[index];
        for (const op of this.getUsedOperandsForReuse(inst)) {
          const key = this.livenessKey(op);
          if (key && !useBeforeDef.has(key)) {
            useBeforeDef.set(key, index);
          }
        }
      }

      const usedOutside = new Set<string>();
      for (let i = 0; i < instructions.length; i++) {
        if (loopIndexSet.has(i)) continue;
        for (const op of this.getUsedOperandsForReuse(instructions[i])) {
          const key = this.livenessKey(op);
          if (key) usedOutside.add(key);
        }
      }

      const candidates: Array<{ index: number; inst: TACInstruction }> = [];
      for (const index of loopIndices) {
        const inst = instructions[index];
        if (!this.isPureProducer(inst)) continue;
        const defined = this.getDefinedOperandForReuse(inst);
        const defKey = this.livenessKey(defined);
        if (!defKey) continue;
        if ((defCounts.get(defKey) ?? 0) !== 1) continue;
        if (usedOutside.has(defKey)) continue;
        if ((useBeforeDef.get(defKey) ?? index) < index) continue;

        const operands = this.getUsedOperandsForReuse(inst);
        const allInvariant = operands.every((op) => {
          const key = this.livenessKey(op);
          if (!key) return true;
          return !loopDefKeys.has(key);
        });
        if (!allInvariant) continue;
        candidates.push({ index, inst });
      }

      if (candidates.length === 0) continue;

      candidates.sort((a, b) => a.index - b.index);
      for (const candidate of candidates) {
        hoistIndices.add(candidate.index);
      }

      const hoisted = candidates.map((candidate) => candidate.inst);
      if (hoisted.length > 0) {
        const existing = hoistMap.get(preheaderInsert) ?? [];
        hoistMap.set(preheaderInsert, existing.concat(hoisted));
      }
    }

    if (hoistIndices.size === 0) return instructions;

    const result: TACInstruction[] = [];
    for (let i = 0; i < instructions.length; i++) {
      const inserts = hoistMap.get(i);
      if (inserts) {
        result.push(...inserts);
      }
      if (hoistIndices.has(i)) continue;
      result.push(instructions[i]);
    }

    const tailInserts = hoistMap.get(instructions.length);
    if (tailInserts) {
      result.push(...tailInserts);
    }

    return result;
  }

  private optimizeInductionVariables(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const cfg = this.buildCFG(instructions);
    if (cfg.blocks.length === 0) return instructions;

    const loops = this.collectLoops(cfg);
    if (loops.length === 0) return instructions;

    const replacements = new Map<number, TACInstruction>();
    const inserts = new Map<number, TACInstruction[]>();
    const handled = new Set<string>();

    for (const loop of loops) {
      const loopBlocks = loop.blocks;
      const preheader = cfg.blocks[loop.preheaderId];
      const insertIndex = this.preheaderInsertIndex(preheader, instructions);

      const loopIndices: number[] = [];
      const loopIndexSet = new Set<number>();
      for (const blockId of loopBlocks) {
        const block = cfg.blocks[blockId];
        for (let i = block.start; i <= block.end; i++) {
          loopIndices.push(i);
          loopIndexSet.add(i);
        }
      }
      loopIndices.sort((a, b) => a - b);

      const defCounts = new Map<string, number>();
      for (const index of loopIndices) {
        const defOp = this.getDefinedOperandForReuse(instructions[index]);
        const defKey = this.livenessKey(defOp);
        if (defKey) {
          defCounts.set(defKey, (defCounts.get(defKey) ?? 0) + 1);
        }
      }

      const usedOutside = new Set<string>();
      for (let i = 0; i < instructions.length; i++) {
        if (loopIndexSet.has(i)) continue;
        for (const op of this.getUsedOperandsForReuse(instructions[i])) {
          const key = this.livenessKey(op);
          if (key) usedOutside.add(key);
        }
      }

      const updates = new Map<
        string,
        { index: number; delta: number; op: "+" | "-"; operand: VariableOperand }
      >();
      for (const index of loopIndices) {
        const inst = instructions[index];
        if (inst.kind !== TACInstructionKind.BinaryOp) continue;
        const bin = inst as BinaryOpInstruction;
        if (bin.operator !== "+" && bin.operator !== "-") continue;
        if (bin.dest.kind !== TACOperandKind.Variable) continue;
        if (bin.left.kind !== TACOperandKind.Variable) continue;
        if ((bin.dest as VariableOperand).name !== (bin.left as VariableOperand).name) {
          continue;
        }
        if (bin.right.kind !== TACOperandKind.Constant) continue;
        const rightConst = bin.right as ConstantOperand;
        if (typeof rightConst.value !== "number") continue;
        if (!Number.isFinite(rightConst.value)) continue;
        const destType = this.getOperandType(bin.dest);
        if (!this.isNumericUdonType(destType.udonType)) continue;
        const key = this.livenessKey(bin.dest);
        if (!key) continue;
        if (updates.has(key)) continue;
        updates.set(key, {
          index,
          delta: rightConst.value,
          op: bin.operator as "+" | "-",
          operand: bin.dest as VariableOperand,
        });
      }

      for (const [varKey, update] of updates) {
        if (handled.has(varKey)) continue;

        let multiplyCandidate:
          | {
              index: number;
              dest: TACOperand;
              factor: number;
              factorType: TypeSymbol;
              operator: "*";
            }
          | null = null;

        for (const index of loopIndices) {
          if (index <= update.index) continue;
          const inst = instructions[index];
          if (inst.kind !== TACInstructionKind.BinaryOp) continue;
          const bin = inst as BinaryOpInstruction;
          if (bin.operator !== "*") continue;
          const leftKey = this.livenessKey(bin.left);
          const rightKey = this.livenessKey(bin.right);
          const varIsLeft = leftKey === varKey;
          const varIsRight = rightKey === varKey;
          if (!varIsLeft && !varIsRight) continue;
          const other = varIsLeft ? bin.right : bin.left;
          if (other.kind !== TACOperandKind.Constant) continue;
          const constOp = other as ConstantOperand;
          if (typeof constOp.value !== "number") continue;
          if (!Number.isFinite(constOp.value)) continue;
          const destType = this.getOperandType(bin.dest);
          if (!this.isNumericUdonType(destType.udonType)) continue;
          const destKey = this.livenessKey(bin.dest);
          if (!destKey) continue;
          if ((defCounts.get(destKey) ?? 0) !== 1) continue;
          if (usedOutside.has(destKey)) continue;
          multiplyCandidate = {
            index,
            dest: bin.dest,
            factor: constOp.value,
            factorType: constOp.type,
            operator: "*",
          };
          break;
        }

        if (!multiplyCandidate) continue;

        const destKey = this.livenessKey(multiplyCandidate.dest);
        if (!destKey) continue;
        if (handled.has(destKey)) continue;

        const delta = update.delta * multiplyCandidate.factor;
        if (!Number.isFinite(delta)) continue;

        const destType = this.getOperandType(multiplyCandidate.dest);
        const deltaValue = this.evaluateCastValue(delta, destType);
        if (deltaValue === null || typeof deltaValue !== "number") continue;

        const initOp = new BinaryOpInstruction(
          multiplyCandidate.dest,
          update.operand,
          "*",
          createConstant(multiplyCandidate.factor, multiplyCandidate.factorType),
        );

        const insertList = inserts.get(insertIndex) ?? [];
        insertList.push(initOp);
        inserts.set(insertIndex, insertList);

        const updateOp =
          update.op === "-"
            ? new BinaryOpInstruction(
                multiplyCandidate.dest,
                multiplyCandidate.dest,
                "-",
                createConstant(deltaValue, destType),
              )
            : new BinaryOpInstruction(
                multiplyCandidate.dest,
                multiplyCandidate.dest,
                "+",
                createConstant(deltaValue, destType),
              );
        replacements.set(multiplyCandidate.index, updateOp);
        handled.add(destKey);
      }
    }

    if (replacements.size === 0 && inserts.size === 0) return instructions;

    const result: TACInstruction[] = [];
    for (let i = 0; i < instructions.length; i++) {
      const pending = inserts.get(i);
      if (pending) result.push(...pending);
      const replacement = replacements.get(i);
      if (replacement) {
        result.push(replacement);
        continue;
      }
      result.push(instructions[i]);
    }

    const tail = inserts.get(instructions.length);
    if (tail) result.push(...tail);

    return result;
  }

  private mergeLatticeMaps(
    predMaps: Array<Map<string, LatticeValue>>,
  ): Map<string, LatticeValue> {
    const valid = predMaps.filter((map) => map !== undefined);
    if (valid.length === 0) return new Map();
    const [first, ...rest] = valid;
    const merged = new Map<string, LatticeValue>();
    for (const [key, value] of first.entries()) {
      let same = true;
      for (const map of rest) {
        const other = map.get(key);
        if (!other || !this.latticeValueEquals(value, other)) {
          same = false;
          break;
        }
      }
      if (same) merged.set(key, value);
    }
    return merged;
  }

  private latticeMapsEqual(
    a: Map<string, LatticeValue>,
    b: Map<string, LatticeValue>,
  ): boolean {
    if (a.size !== b.size) return false;
    for (const [key, value] of a.entries()) {
      const other = b.get(key);
      if (!other || !this.latticeValueEquals(value, other)) return false;
    }
    return true;
  }

  private latticeValueEquals(a: LatticeValue, b: LatticeValue): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "constant" && b.kind === "constant") {
      return (
        a.operand.type.udonType === b.operand.type.udonType &&
        this.stringifyConstant(a.operand.value) ===
          this.stringifyConstant(b.operand.value)
      );
    }
    if (a.kind === "copy" && b.kind === "copy") {
      return a.operand.name === b.operand.name;
    }
    if (a.kind === "unknown" && b.kind === "unknown") return true;
    return false;
  }

  private transferLatticeMap(
    current: Map<string, LatticeValue>,
    inst: TACInstruction,
  ): Map<string, LatticeValue> {
    const next = new Map(current);
    if (
      inst.kind === TACInstructionKind.Assignment ||
      inst.kind === TACInstructionKind.Copy
    ) {
      const { dest, src } = inst as unknown as InstWithDestSrc;
      if (dest.kind === TACOperandKind.Variable) {
        const destName = (dest as VariableOperand).name;
        const resolvedConst = this.resolveLatticeConstant(src, next);
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

    const defined = this.getDefinedOperandForReuse(inst);
    if (defined && defined.kind === TACOperandKind.Variable) {
      next.delete((defined as VariableOperand).name);
    }
    return next;
  }

  private resolveLatticeConstant(
    operand: TACOperand,
    map: Map<string, LatticeValue>,
  ): ConstantOperand | null {
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
  }

  private resolveLatticeOperand(
    operand: TACOperand,
    map: Map<string, LatticeValue>,
  ): TACOperand {
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
  }

  private replaceInstructionWithLatticeMap(
    inst: TACInstruction,
    map: Map<string, LatticeValue>,
  ): TACInstruction {
    const replace = (operand: TACOperand): TACOperand =>
      this.resolveLatticeOperand(operand, map);

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
        return new AssignmentInstruction(dest, resolved);
      }
    }

    if (inst.kind === TACInstructionKind.Cast) {
      const castInst = inst as unknown as InstWithDestSrc;
      const resolved = replace(castInst.src);
      if (resolved !== castInst.src) {
        return new CastInstruction(castInst.dest, resolved);
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
  }

  private resolveReachableSuccs(
    block: BasicBlock,
    instructions: TACInstruction[],
    labelToBlock: Map<string, number>,
    map: Map<string, LatticeValue>,
    blockCount: number,
  ): number[] {
    if (block.end < block.start) return [];
    const last = instructions[block.end];
    const fallthrough =
      block.id + 1 < blockCount ? block.id + 1 : undefined;

    if (last.kind === TACInstructionKind.UnconditionalJump) {
      const label = (last as UnconditionalJumpInstruction).label;
      if (label.kind === TACOperandKind.Label) {
        const target = labelToBlock.get((label as LabelOperand).name);
        return target !== undefined ? [target] : [];
      }
      return [];
    }

    if (last.kind === TACInstructionKind.ConditionalJump) {
      const condInst = last as ConditionalJumpInstruction;
      const conditionConst = this.resolveLatticeConstant(
        condInst.condition,
        map,
      );
      const label = condInst.label;
      const target =
        label.kind === TACOperandKind.Label
          ? labelToBlock.get((label as LabelOperand).name)
          : undefined;
      const truthy = conditionConst
        ? this.isTruthyConstant(conditionConst.value)
        : null;
      if (truthy === true) {
        return fallthrough !== undefined ? [fallthrough] : [];
      }
      if (truthy === false) {
        return target !== undefined ? [target] : [];
      }
      const succs: number[] = [];
      if (target !== undefined) succs.push(target);
      if (fallthrough !== undefined) succs.push(fallthrough);
      return succs;
    }

    if (last.kind === TACInstructionKind.Return) {
      return [];
    }

    return fallthrough !== undefined ? [fallthrough] : [];
  }

  private isTruthyConstant(value: ConstantValue): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    return null;
  }

  private getBooleanConstant(operand: TACOperand): boolean | null {
    if (operand.kind !== TACOperandKind.Constant) return null;
    const constOp = operand as ConstantOperand;
    if (typeof constOp.value !== "boolean") return null;
    return constOp.value;
  }

  private livenessKey(operand: TACOperand | undefined): string | null {
    if (!operand) return null;
    if (operand.kind === TACOperandKind.Variable) {
      return `v:${(operand as VariableOperand).name}`;
    }
    if (operand.kind === TACOperandKind.Temporary) {
      return `t:${(operand as TemporaryOperand).id}`;
    }
    return null;
  }

  private stringSetEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  private numberSetEqual(a: Set<number>, b: Set<number>): boolean {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  private intersectExpressionMaps(
    predMaps: Array<Map<string, ExprValue>>,
  ): Map<string, ExprValue> {
    if (predMaps.length === 0) return new Map();
    const [first, ...rest] = predMaps;
    const merged = new Map<string, ExprValue>();
    for (const [key, value] of first.entries()) {
      let same = true;
      for (const map of rest) {
        const other = map.get(key);
        if (!other || other.operandKey !== value.operandKey) {
          same = false;
          break;
        }
      }
      if (same) merged.set(key, value);
    }
    return merged;
  }

  private exprMapsEqual(
    a: Map<string, ExprValue>,
    b: Map<string, ExprValue>,
  ): boolean {
    if (a.size !== b.size) return false;
    for (const [key, value] of a.entries()) {
      const other = b.get(key);
      if (!other || other.operandKey !== value.operandKey) return false;
    }
    return true;
  }

  private simulateExpressionMap(
    start: Map<string, ExprValue>,
    instructions: TACInstruction[],
    startIndex: number,
    endIndex: number,
  ): Map<string, ExprValue> {
    const working = new Map(start);
    for (let i = startIndex; i <= endIndex; i++) {
      const inst = instructions[i];
      const defined = this.getDefinedOperandForReuse(inst);
      const defKey = this.gvnOperandKey(defined);
      if (defKey) {
        this.killExpressionsUsingOperand(working, defKey);
      }

      if (inst.kind === TACInstructionKind.BinaryOp) {
        const bin = inst as BinaryOpInstruction;
        const exprKey = this.binaryExprKey(bin);
        working.set(exprKey, {
          operandKey: this.operandKey(bin.dest),
          operand: bin.dest,
        });
      }

      if (inst.kind === TACInstructionKind.UnaryOp) {
        const un = inst as UnaryOpInstruction;
        const exprKey = this.unaryExprKey(un);
        working.set(exprKey, {
          operandKey: this.operandKey(un.dest),
          operand: un.dest,
        });
      }

      if (inst.kind === TACInstructionKind.Cast) {
        const castInst = inst as CastInstruction;
        const exprKey = this.castExprKey(castInst);
        working.set(exprKey, {
          operandKey: this.operandKey(castInst.dest),
          operand: castInst.dest,
        });
      }
    }
    return working;
  }

  private killExpressionsUsingOperand(
    map: Map<string, ExprValue>,
    operandKey: string,
  ): void {
    const needle = `|${operandKey}|`;
    for (const key of Array.from(map.keys())) {
      if (key.includes(needle)) {
        map.delete(key);
      }
    }
  }

  private gvnOperandKey(operand: TACOperand | undefined): string | null {
    if (!operand) return null;
    if (operand.kind === TACOperandKind.Variable) {
      return `v:${(operand as VariableOperand).name}`;
    }
    if (operand.kind === TACOperandKind.Temporary) {
      return `t:${(operand as TemporaryOperand).id}`;
    }
    return null;
  }

  private isCommutativeOperator(op: string): boolean {
    return (
      op === "+" ||
      op === "*" ||
      op === "==" ||
      op === "!=" ||
      op === "&&" ||
      op === "||"
    );
  }

  private binaryExprKey(inst: BinaryOpInstruction): string {
    const typeKey = this.getOperandType(inst.dest).udonType;
    let leftKey = this.operandKey(inst.left);
    let rightKey = this.operandKey(inst.right);
    if (this.isCommutativeOperator(inst.operator)) {
      if (leftKey > rightKey) {
        const tmp = leftKey;
        leftKey = rightKey;
        rightKey = tmp;
      }
    }
    return `bin|${inst.operator}|${leftKey}|${rightKey}|${typeKey}|`;
  }

  private unaryExprKey(inst: UnaryOpInstruction): string {
    const typeKey = this.getOperandType(inst.dest).udonType;
    const operandKey = this.operandKey(inst.operand);
    return `un|${inst.operator}|${operandKey}|${typeKey}|`;
  }

  private castExprKey(inst: CastInstruction): string {
    const typeKey = this.getOperandType(inst.dest).udonType;
    const operandKey = this.operandKey(inst.src);
    return `cast|${operandKey}|${typeKey}|`;
  }

  private collectLoops(cfg: { blocks: BasicBlock[] }): Array<{
    headerId: number;
    blocks: Set<number>;
    preheaderId: number;
  }> {
    const dom = this.computeDominators(cfg);
    const loopsByHeader = new Map<number, Set<number>>();

    for (const block of cfg.blocks) {
      for (const succ of block.succs) {
        const doms = dom.get(block.id);
        if (doms && doms.has(succ)) {
          const loop = new Set<number>([succ, block.id]);
          const stack = [block.id];
          while (stack.length > 0) {
            const current = stack.pop() as number;
            if (current === succ) continue;
            const preds = cfg.blocks[current].preds;
            for (const pred of preds) {
              if (!loop.has(pred)) {
                loop.add(pred);
                stack.push(pred);
              }
            }
          }
          const existing = loopsByHeader.get(succ);
          if (existing) {
            for (const id of loop) existing.add(id);
          } else {
            loopsByHeader.set(succ, loop);
          }
        }
      }
    }

    const loops: Array<{
      headerId: number;
      blocks: Set<number>;
      preheaderId: number;
    }> = [];
    for (const [headerId, blocks] of loopsByHeader.entries()) {
      const headerBlock = cfg.blocks[headerId];
      const externalPreds = headerBlock.preds.filter((id) => !blocks.has(id));
      if (externalPreds.length !== 1) continue;
      loops.push({
        headerId,
        blocks,
        preheaderId: externalPreds[0],
      });
    }
    return loops;
  }

  private preheaderInsertIndex(
    preheader: BasicBlock,
    instructions: TACInstruction[],
  ): number {
    if (preheader.end < preheader.start) return preheader.start;
    const last = instructions[preheader.end];
    if (last && this.isBlockTerminator(last)) {
      return preheader.end;
    }
    return preheader.end + 1;
  }

  private cfgPropagateConstantsAndCopies(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const cfg = this.buildCFG(instructions);
    if (cfg.blocks.length === 0) return instructions;

    const inMaps = new Map<number, Map<string, ValueInfo>>();
    const outMaps = new Map<number, Map<string, ValueInfo>>();

    for (const block of cfg.blocks) {
      inMaps.set(block.id, new Map());
      outMaps.set(block.id, new Map());
    }

    let changed = true;
    while (changed) {
      changed = false;

      for (const block of cfg.blocks) {
        const predMaps = block.preds.map((id) => outMaps.get(id));
        const mergedIn = this.mergeValueMaps(predMaps);
        const currentIn = inMaps.get(block.id) ?? new Map();
        if (!this.valueMapsEqual(currentIn, mergedIn)) {
          inMaps.set(block.id, mergedIn);
          changed = true;
        }

        let working = new Map(mergedIn);
        for (let i = block.start; i <= block.end; i++) {
          working = this.transferValueMap(working, instructions[i]);
        }

        const currentOut = outMaps.get(block.id) ?? new Map();
        if (!this.valueMapsEqual(currentOut, working)) {
          outMaps.set(block.id, working);
          changed = true;
        }
      }
    }

    const result: TACInstruction[] = [];
    for (const block of cfg.blocks) {
      let working = new Map(inMaps.get(block.id) ?? new Map());
      for (let i = block.start; i <= block.end; i++) {
        const rewritten = this.replaceInstructionWithMap(
          instructions[i],
          working,
        );
        result.push(rewritten);
        working = this.transferValueMap(working, rewritten);
      }
    }

    return result;
  }

  private copyOnWriteTemporaries(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    let maxTempId = -1;
    const recordTemp = (operand: TACOperand | undefined) => {
      if (!operand || operand.kind !== TACOperandKind.Temporary) return;
      const temp = operand as TemporaryOperand;
      if (temp.id > maxTempId) maxTempId = temp.id;
    };

    for (const inst of instructions) {
      const used = this.getUsedOperandsForReuse(inst);
      for (const operand of used) recordTemp(operand);
      const defined = this.getDefinedOperandForReuse(inst);
      recordTemp(defined);
    }

    let nextTempId = maxTempId + 1;
    const aliasMap = new Map<number, TemporaryOperand>();
    const aliasGroups = new Map<number, Set<number>>();

    const ensureAlias = (temp: TemporaryOperand) => {
      if (aliasMap.has(temp.id)) return;
      aliasMap.set(temp.id, temp);
      aliasGroups.set(temp.id, new Set([temp.id]));
    };

    const getAliasTarget = (temp: TemporaryOperand): TemporaryOperand => {
      ensureAlias(temp);
      return aliasMap.get(temp.id) as TemporaryOperand;
    };

    const removeAlias = (aliasId: number) => {
      const target = aliasMap.get(aliasId);
      if (!target) return;
      const group = aliasGroups.get(target.id);
      if (group) {
        group.delete(aliasId);
        if (group.size === 0) aliasGroups.delete(target.id);
      }
    };

    const resetAlias = (temp: TemporaryOperand) => {
      removeAlias(temp.id);
      aliasMap.set(temp.id, temp);
      aliasGroups.set(temp.id, new Set([temp.id]));
    };

    const setAlias = (
      aliasTemp: TemporaryOperand,
      targetTemp: TemporaryOperand,
    ) => {
      ensureAlias(targetTemp);
      removeAlias(aliasTemp.id);
      aliasMap.set(aliasTemp.id, targetTemp);
      let group = aliasGroups.get(targetTemp.id);
      if (!group) {
        group = new Set();
        aliasGroups.set(targetTemp.id, group);
      }
      group.add(aliasTemp.id);
    };

    const isShared = (temp: TemporaryOperand): boolean => {
      const target = getAliasTarget(temp);
      const group = aliasGroups.get(target.id);
      return (group?.size ?? 1) > 1;
    };

    const rewriteOperand = (operand: TACOperand): TACOperand => {
      if (operand.kind !== TACOperandKind.Temporary) return operand;
      return getAliasTarget(operand as TemporaryOperand);
    };

    const rewriteInstruction = (inst: TACInstruction): TACInstruction => {
      if (inst.kind === TACInstructionKind.BinaryOp) {
        const bin = inst as BinaryOpInstruction;
        const left = rewriteOperand(bin.left);
        const right = rewriteOperand(bin.right);
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
        const operand = rewriteOperand(un.operand);
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
        const resolved = rewriteOperand(src);
        if (resolved !== src) {
          return new AssignmentInstruction(dest, resolved);
        }
      }

      if (inst.kind === TACInstructionKind.Cast) {
        const castInst = inst as unknown as InstWithDestSrc;
        const resolved = rewriteOperand(castInst.src);
        if (resolved !== castInst.src) {
          return new CastInstruction(castInst.dest, resolved);
        }
      }

      if (inst.kind === TACInstructionKind.ConditionalJump) {
        const cond = inst as ConditionalJumpInstruction;
        const condition = rewriteOperand(cond.condition);
        if (condition !== cond.condition) {
          return new (cond.constructor as typeof ConditionalJumpInstruction)(
            condition,
            cond.label,
          );
        }
      }

      if (inst.kind === TACInstructionKind.Call) {
        const call = inst as CallInstruction;
        const args = call.args.map((arg) => rewriteOperand(arg));
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
        const object = rewriteOperand(call.object);
        const args = call.args.map((arg) => rewriteOperand(arg));
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
        const object = rewriteOperand(get.object);
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
        const object = rewriteOperand(set.object);
        const value = rewriteOperand(set.value);
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
          const value = rewriteOperand(ret.value);
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
        const array = rewriteOperand(access.array);
        const index = rewriteOperand(access.index);
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
        const array = rewriteOperand(assign.array);
        const index = rewriteOperand(assign.index);
        const value = rewriteOperand(assign.value);
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

    const shouldTreatMethodAsMutation = (
      call: MethodCallInstruction,
    ): boolean => {
      const targetType = this.getOperandType(call.object);
      return this.isCopyOnWriteCandidateType(targetType);
    };

    const result: TACInstruction[] = [];

    for (const inst of instructions) {
      if (
        inst.kind === TACInstructionKind.Assignment ||
        inst.kind === TACInstructionKind.Copy
      ) {
        const { dest, src } = inst as unknown as InstWithDestSrc;
        const resolvedSrc = rewriteOperand(src);
        if (
          dest.kind === TACOperandKind.Temporary &&
          resolvedSrc.kind === TACOperandKind.Temporary &&
          this.getOperandType(dest).udonType ===
            this.getOperandType(resolvedSrc).udonType
        ) {
          setAlias(dest as TemporaryOperand, resolvedSrc as TemporaryOperand);
          continue;
        }

        if (dest.kind === TACOperandKind.Temporary) {
          resetAlias(dest as TemporaryOperand);
        }

        if (resolvedSrc !== src) {
          result.push(new AssignmentInstruction(dest, resolvedSrc));
        } else {
          result.push(inst);
        }
        continue;
      }

      if (inst.kind === TACInstructionKind.PropertySet) {
        const set = inst as PropertySetInstruction;
        if (
          set.object.kind === TACOperandKind.Temporary &&
          isShared(set.object as TemporaryOperand)
        ) {
          const newTemp = createTemporary(
            nextTempId++,
            this.getOperandType(set.object),
          );
          result.push(
            new CopyInstruction(
              newTemp,
              getAliasTarget(set.object as TemporaryOperand),
            ),
          );
          resetAlias(newTemp);
          setAlias(set.object as TemporaryOperand, newTemp);
        }

        const rewritten = rewriteInstruction(inst);
        result.push(rewritten);
        continue;
      }

      if (inst.kind === TACInstructionKind.ArrayAssignment) {
        const assign = inst as ArrayAssignmentInstruction;
        if (
          assign.array.kind === TACOperandKind.Temporary &&
          isShared(assign.array as TemporaryOperand)
        ) {
          const newTemp = createTemporary(
            nextTempId++,
            this.getOperandType(assign.array),
          );
          result.push(
            new CopyInstruction(
              newTemp,
              getAliasTarget(assign.array as TemporaryOperand),
            ),
          );
          resetAlias(newTemp);
          setAlias(assign.array as TemporaryOperand, newTemp);
        }

        const rewritten = rewriteInstruction(inst);
        result.push(rewritten);
        continue;
      }

      if (inst.kind === TACInstructionKind.MethodCall) {
        const call = inst as MethodCallInstruction;
        if (
          call.object.kind === TACOperandKind.Temporary &&
          isShared(call.object as TemporaryOperand) &&
          shouldTreatMethodAsMutation(call)
        ) {
          const newTemp = createTemporary(
            nextTempId++,
            this.getOperandType(call.object),
          );
          result.push(
            new CopyInstruction(
              newTemp,
              getAliasTarget(call.object as TemporaryOperand),
            ),
          );
          resetAlias(newTemp);
          setAlias(call.object as TemporaryOperand, newTemp);
        }

        const rewritten = rewriteInstruction(inst);
        result.push(rewritten);
        const defined = this.getDefinedOperandForReuse(rewritten);
        if (defined?.kind === TACOperandKind.Temporary) {
          resetAlias(defined as TemporaryOperand);
        }
        continue;
      }

      const rewritten = rewriteInstruction(inst);
      result.push(rewritten);
      const defined = this.getDefinedOperandForReuse(rewritten);
      if (defined?.kind === TACOperandKind.Temporary) {
        resetAlias(defined as TemporaryOperand);
      }
    }

    return result;
  }

  private algebraicSimplification(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const result: TACInstruction[] = [];

    for (const inst of instructions) {
      if (inst.kind === TACInstructionKind.BinaryOp) {
        const simplified = this.trySimplifyBinaryOp(
          inst as BinaryOpInstruction,
        );
        if (simplified) {
          result.push(simplified);
          continue;
        }
      }

      if (inst.kind === TACInstructionKind.UnaryOp) {
        const simplified = this.trySimplifyUnaryOp(inst as UnaryOpInstruction);
        if (simplified) {
          result.push(simplified);
          continue;
        }
      }

      if (inst.kind === TACInstructionKind.Cast) {
        const simplified = this.trySimplifyCast(inst as CastInstruction);
        if (simplified) {
          result.push(simplified);
          continue;
        }
      }

      result.push(inst);
    }

    return result;
  }

  private simplifyBranches(instructions: TACInstruction[]): TACInstruction[] {
    const result: TACInstruction[] = [];

    for (const inst of instructions) {
      if (inst.kind === TACInstructionKind.ConditionalJump) {
        const condJump = inst as ConditionalJumpInstruction;
        if (condJump.condition.kind === TACOperandKind.Constant) {
          const constOp = condJump.condition as ConstantOperand;
          const value = constOp.value;
          // Conditions in TAC should be boolean/number; other ConstantValue
          // types are not treated as truthy/falsy here.
          if (typeof value === "boolean" || typeof value === "number") {
            const isFalse =
              typeof value === "boolean"
                ? value === false
                : value === 0 || Number.isNaN(value);
            if (isFalse) {
              result.push(new UnconditionalJumpInstruction(condJump.label));
            }
            continue;
          }
        }
      }

      result.push(inst);
    }

    return result;
  }

  private eliminateSingleUseTemporaries(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const cfg = this.buildCFG(instructions);
    if (cfg.blocks.length === 0) return instructions;

    const result: TACInstruction[] = [];

    for (const block of cfg.blocks) {
      const blockInstructions = instructions.slice(block.start, block.end + 1);
      const tempUseCounts = this.countTempUses(blockInstructions);

      for (let i = 0; i < blockInstructions.length; i++) {
        const inst = blockInstructions[i];
        const next = blockInstructions[i + 1];

        if (next && this.isPureProducer(inst) && this.isCopyFromTemp(next)) {
          const destTemp = (inst as unknown as InstWithDest).dest;
          if (
            destTemp.kind === TACOperandKind.Temporary &&
            (next as unknown as InstWithDestSrc).src.kind ===
              TACOperandKind.Temporary
          ) {
            const tempId = (destTemp as TemporaryOperand).id;
            const nextTempId = (
              (next as unknown as InstWithDestSrc).src as TemporaryOperand
            ).id;

            if (tempId === nextTempId && tempUseCounts.get(tempId) === 1) {
              const nextDest = (next as unknown as InstWithDestSrc).dest;
              if (this.sameUdonType(destTemp, nextDest)) {
                const rewritten = this.rewriteProducerDest(inst, nextDest);
                result.push(rewritten);
                i += 1;
                continue;
              }
            }
          }
        }

        result.push(inst);
      }
    }

    return result;
  }

  private eliminateNoopCopies(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const result: TACInstruction[] = [];

    for (const inst of instructions) {
      if (
        inst.kind === TACInstructionKind.Assignment ||
        inst.kind === TACInstructionKind.Copy
      ) {
        const { dest, src } = inst as unknown as InstWithDestSrc;
        if (this.sameOperand(dest, src)) {
          continue;
        }
      }
      result.push(inst);
    }

    return result;
  }

  private eliminateDeadTemporaries(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    let current = instructions;

    while (true) {
      const uses = new Map<number, number>();
      const recordUse = (operand: TACOperand) => {
        if (operand.kind !== TACOperandKind.Temporary) return;
        const id = (operand as TemporaryOperand).id;
        uses.set(id, (uses.get(id) ?? 0) + 1);
      };

      for (const inst of current) {
        for (const op of this.getUsedOperandsForReuse(inst)) {
          recordUse(op);
        }
      }

      let changed = false;
      const result: TACInstruction[] = [];
      for (const inst of current) {
        if (this.isPureProducer(inst)) {
          const defined = this.getDefinedOperandForReuse(inst);
          if (defined?.kind === TACOperandKind.Temporary) {
            const id = (defined as TemporaryOperand).id;
            if (!uses.has(id)) {
              changed = true;
              continue;
            }
          }
        }
        result.push(inst);
      }

      if (!changed) {
        return result;
      }
      current = result;
    }
  }

  private simplifyJumps(instructions: TACInstruction[]): TACInstruction[] {
    if (instructions.length === 0) return instructions;

    const labelAlias = new Map<string, string>();
    for (let i = 0; i < instructions.length; i += 1) {
      const inst = instructions[i];
      if (inst.kind !== TACInstructionKind.Label) continue;
      const names: string[] = [];
      let j = i;
      while (
        j < instructions.length &&
        instructions[j].kind === TACInstructionKind.Label
      ) {
        const labelInst = instructions[j] as LabelInstruction;
        if (labelInst.label.kind === TACOperandKind.Label) {
          names.push((labelInst.label as LabelOperand).name);
        }
        j += 1;
      }
      if (names.length > 0) {
        const canonical = names[names.length - 1];
        for (const name of names) {
          labelAlias.set(name, canonical);
        }
      }
      i = j - 1;
    }

    const canonicalLabel = (name: string): string => labelAlias.get(name) ?? name;

    const labelIndex = new Map<string, number>();
    for (let i = 0; i < instructions.length; i += 1) {
      const inst = instructions[i];
      if (inst.kind !== TACInstructionKind.Label) continue;
      const labelInst = inst as LabelInstruction;
      if (labelInst.label.kind !== TACOperandKind.Label) continue;
      const name = canonicalLabel((labelInst.label as LabelOperand).name);
      labelIndex.set(name, i);
    }

    const resolveLabelName = (name: string): string => {
      let current = canonicalLabel(name);
      const seen = new Set<string>();

      while (!seen.has(current)) {
        seen.add(current);
        const index = labelIndex.get(current);
        if (index === undefined) break;

        let nextIndex = index + 1;
        while (
          nextIndex < instructions.length &&
          instructions[nextIndex].kind === TACInstructionKind.Label
        ) {
          nextIndex += 1;
        }

        if (nextIndex >= instructions.length) break;
        const nextInst = instructions[nextIndex];
        if (nextInst.kind !== TACInstructionKind.UnconditionalJump) break;

        const target = (nextInst as UnconditionalJumpInstruction).label;
        if (target.kind !== TACOperandKind.Label) break;

        current = canonicalLabel((target as LabelOperand).name);
      }

      return current;
    };

    const resolved = new Map<string, string>();
    for (const name of labelIndex.keys()) {
      resolved.set(name, resolveLabelName(name));
    }

    const isJumpToNextLabel = (index: number, targetName: string): boolean => {
      for (let i = index + 1; i < instructions.length; i += 1) {
        const inst = instructions[i];
        if (inst.kind !== TACInstructionKind.Label) return false;
        const labelInst = inst as LabelInstruction;
        if (labelInst.label.kind !== TACOperandKind.Label) continue;
        const name = canonicalLabel((labelInst.label as LabelOperand).name);
        if (name === targetName) return true;
      }
      return false;
    };

    const result: TACInstruction[] = [];
    for (let i = 0; i < instructions.length; i += 1) {
      const inst = instructions[i];
      if (inst.kind === TACInstructionKind.Label) {
        const labelInst = inst as LabelInstruction;
        if (labelInst.label.kind === TACOperandKind.Label) {
          const name = (labelInst.label as LabelOperand).name;
          if (canonicalLabel(name) !== name) {
            continue;
          }
        }
      }
      if (
        inst.kind === TACInstructionKind.UnconditionalJump ||
        inst.kind === TACInstructionKind.ConditionalJump
      ) {
        const label = (inst as unknown as { label: TACOperand }).label;
        if (label.kind === TACOperandKind.Label) {
          const labelName = canonicalLabel((label as LabelOperand).name);
          const resolvedName = resolved.get(labelName) ?? labelName;
          if (isJumpToNextLabel(i, resolvedName)) {
            continue;
          }
          if (resolvedName !== labelName) {
            const resolvedLabel = createLabel(resolvedName);
            if (inst.kind === TACInstructionKind.UnconditionalJump) {
              result.push(new UnconditionalJumpInstruction(resolvedLabel));
            } else {
              const cond = (inst as ConditionalJumpInstruction).condition;
              result.push(new ConditionalJumpInstruction(cond, resolvedLabel));
            }
            continue;
          }
        }
      }
      result.push(inst);
    }

    return this.mergeLinearBlocks(result);
  }

  private mergeLinearBlocks(instructions: TACInstruction[]): TACInstruction[] {
    let current = instructions;
    while (true) {
      const cfg = this.buildCFG(current);
      if (cfg.blocks.length === 0) return current;

      const labelToBlock = new Map<string, number>();
      for (const block of cfg.blocks) {
        for (let i = block.start; i <= block.end; i++) {
          const inst = current[i];
          if (inst.kind !== TACInstructionKind.Label) continue;
          const labelInst = inst as LabelInstruction;
          if (labelInst.label.kind !== TACOperandKind.Label) continue;
          labelToBlock.set((labelInst.label as LabelOperand).name, block.id);
        }
      }

      const mergeMap = new Map<number, number>();
      const mergedTargets = new Set<number>();
      for (const block of cfg.blocks) {
        if (mergedTargets.has(block.id)) continue;
        const lastInst = current[block.end];
        if (lastInst?.kind !== TACInstructionKind.UnconditionalJump) continue;
        const targetLabel = (lastInst as UnconditionalJumpInstruction).label;
        if (targetLabel.kind !== TACOperandKind.Label) continue;
        const targetId = labelToBlock.get((targetLabel as LabelOperand).name);
        if (targetId === undefined || targetId === block.id) continue;
        const targetBlock = cfg.blocks[targetId];
        if (targetBlock.preds.length !== 1) continue;
        mergeMap.set(block.id, targetId);
        mergedTargets.add(targetId);
      }

      if (mergeMap.size === 0) return current;

      const result: TACInstruction[] = [];
      for (const block of cfg.blocks) {
        if (mergedTargets.has(block.id)) continue;
        const mergeTarget = mergeMap.get(block.id);
        if (mergeTarget !== undefined) {
          for (let i = block.start; i <= block.end; i++) {
            if (i === block.end) continue; // drop the unconditional jump
            result.push(current[i]);
          }
          const targetBlock = cfg.blocks[mergeTarget];
          let start = targetBlock.start;
          while (
            start <= targetBlock.end &&
            current[start].kind === TACInstructionKind.Label
          ) {
            start += 1;
          }
          for (let i = start; i <= targetBlock.end; i++) {
            result.push(current[i]);
          }
          continue;
        }

        for (let i = block.start; i <= block.end; i++) {
          result.push(current[i]);
        }
      }

      current = result;
    }
  }

  private buildCFG(instructions: TACInstruction[]): { blocks: BasicBlock[] } {
    if (instructions.length === 0) {
      return { blocks: [] };
    }

    const leaders = new Set<number>();
    leaders.add(0);

    for (let i = 0; i < instructions.length; i++) {
      const inst = instructions[i];
      if (inst.kind === TACInstructionKind.Label) {
        leaders.add(i);
      }
      if (this.isBlockTerminator(inst) && i + 1 < instructions.length) {
        leaders.add(i + 1);
      }
    }

    const sortedLeaders = Array.from(leaders).sort((a, b) => a - b);
    const blocks: BasicBlock[] = [];
    for (let i = 0; i < sortedLeaders.length; i++) {
      const start = sortedLeaders[i];
      const end =
        i + 1 < sortedLeaders.length
          ? sortedLeaders[i + 1] - 1
          : instructions.length - 1;
      blocks.push({ id: i, start, end, preds: [], succs: [] });
    }

    const labelToBlock = new Map<string, number>();
    for (const block of blocks) {
      for (let i = block.start; i <= block.end; i++) {
        const inst = instructions[i];
        if (inst.kind === TACInstructionKind.Label) {
          const labelInst = inst as LabelInstruction;
          if (labelInst.label.kind === TACOperandKind.Label) {
            const label = labelInst.label as LabelOperand;
            labelToBlock.set(label.name, block.id);
          }
        }
      }
    }

    for (const block of blocks) {
      const lastInst = instructions[block.end];
      if (lastInst.kind === TACInstructionKind.UnconditionalJump) {
        const label = (lastInst as UnconditionalJumpInstruction).label as {
          name?: string;
        };
        const target = label?.name ? labelToBlock.get(label.name) : undefined;
        if (target !== undefined) {
          block.succs.push(target);
        }
      } else if (lastInst.kind === TACInstructionKind.ConditionalJump) {
        const label = (lastInst as ConditionalJumpInstruction).label as {
          name?: string;
        };
        const target = label?.name ? labelToBlock.get(label.name) : undefined;
        if (target !== undefined) {
          block.succs.push(target);
        }
        const fallthrough = block.id + 1;
        if (fallthrough < blocks.length) {
          block.succs.push(fallthrough);
        }
      } else if (lastInst.kind !== TACInstructionKind.Return) {
        const fallthrough = block.id + 1;
        if (fallthrough < blocks.length) {
          block.succs.push(fallthrough);
        }
      }
    }

    for (const block of blocks) {
      for (const succ of block.succs) {
        blocks[succ].preds.push(block.id);
      }
    }

    return { blocks };
  }

  private isBlockTerminator(inst: TACInstruction): boolean {
    return (
      inst.kind === TACInstructionKind.UnconditionalJump ||
      inst.kind === TACInstructionKind.ConditionalJump ||
      inst.kind === TACInstructionKind.Return
    );
  }

  private mergeValueMaps(
    predMaps: Array<Map<string, ValueInfo> | undefined>,
  ): Map<string, ValueInfo> {
    const validMaps = predMaps.filter(
      (map): map is Map<string, ValueInfo> => map !== undefined,
    );
    if (validMaps.length === 0) return new Map();

    const [first, ...rest] = validMaps;
    const merged = new Map<string, ValueInfo>();

    for (const [key, value] of first.entries()) {
      let same = true;
      for (const map of rest) {
        const other = map.get(key);
        if (!other || !this.valueInfoEquals(value, other)) {
          same = false;
          break;
        }
      }
      if (same) {
        merged.set(key, value);
      }
    }

    return merged;
  }

  private valueMapsEqual(
    a: Map<string, ValueInfo>,
    b: Map<string, ValueInfo>,
  ): boolean {
    if (a.size !== b.size) return false;
    for (const [key, value] of a.entries()) {
      const other = b.get(key);
      if (!other || !this.valueInfoEquals(value, other)) return false;
    }
    return true;
  }

  private valueInfoEquals(a: ValueInfo, b: ValueInfo): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "constant" && b.kind === "constant") {
      return (
        a.operand.type.udonType === b.operand.type.udonType &&
        this.stringifyConstant(a.operand.value) ===
          this.stringifyConstant(b.operand.value)
      );
    }
    if (a.kind === "copy" && b.kind === "copy") {
      if (a.operand.kind !== TACOperandKind.Variable) return false;
      if (b.operand.kind !== TACOperandKind.Variable) return false;
      return (
        (a.operand as VariableOperand).name ===
        (b.operand as VariableOperand).name
      );
    }
    return false;
  }

  private transferValueMap(
    current: Map<string, ValueInfo>,
    inst: TACInstruction,
  ): Map<string, ValueInfo> {
    const next = new Map(current);
    const destVar = this.getAssignedVariableName(inst);

    if (
      inst.kind === TACInstructionKind.Assignment ||
      inst.kind === TACInstructionKind.Copy
    ) {
      const { dest, src } = inst as unknown as InstWithDestSrc;
      if (dest.kind === TACOperandKind.Variable) {
        const resolved = this.resolveOperandValue(src, next);
        if (resolved) {
          next.set((dest as VariableOperand).name, resolved);
        } else if (src.kind === TACOperandKind.Constant) {
          next.set((dest as VariableOperand).name, {
            kind: "constant",
            operand: src as ConstantOperand,
          });
        } else if (src.kind === TACOperandKind.Variable) {
          next.set((dest as VariableOperand).name, {
            kind: "copy",
            operand: src,
          });
        } else {
          next.delete((dest as VariableOperand).name);
        }
      }
      return next;
    }

    if (
      inst.kind === TACInstructionKind.BinaryOp ||
      inst.kind === TACInstructionKind.UnaryOp ||
      inst.kind === TACInstructionKind.Cast ||
      inst.kind === TACInstructionKind.Call ||
      inst.kind === TACInstructionKind.MethodCall ||
      inst.kind === TACInstructionKind.PropertyGet ||
      inst.kind === TACInstructionKind.ArrayAccess
    ) {
      if (destVar) {
        next.delete(destVar);
      }
      return next;
    }

    if (destVar) {
      next.delete(destVar);
    }

    return next;
  }

  private resolveOperandValue(
    operand: TACOperand,
    map: Map<string, ValueInfo>,
  ): ValueInfo | null {
    if (operand.kind !== TACOperandKind.Variable) return null;
    const visited = new Set<string>();
    let currentName = (operand as VariableOperand).name;

    while (!visited.has(currentName)) {
      visited.add(currentName);
      const info = map.get(currentName);
      if (!info) return null;
      if (info.kind === "constant") return info;
      if (info.kind === "copy") {
        if (info.operand.kind !== TACOperandKind.Variable) return null;
        const nextName = (info.operand as VariableOperand).name;
        const nextInfo = map.get(nextName);
        if (!nextInfo) {
          return { kind: "copy", operand: info.operand };
        }
        currentName = nextName;
      }
    }
    return null;
  }

  private replaceInstructionWithMap(
    inst: TACInstruction,
    map: Map<string, ValueInfo>,
  ): TACInstruction {
    const replace = (operand: TACOperand): TACOperand => {
      if (operand.kind !== TACOperandKind.Variable) return operand;
      const resolved = this.resolveOperandValue(operand, map);
      if (!resolved) return operand;
      return resolved.operand;
    };

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
        return new AssignmentInstruction(dest, resolved);
      }
    }

    if (inst.kind === TACInstructionKind.Cast) {
      const castInst = inst as unknown as InstWithDestSrc;
      const resolved = replace(castInst.src);
      if (resolved !== castInst.src) {
        return new CastInstruction(castInst.dest, resolved);
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
  }

  private isPureProducer(inst: TACInstruction): boolean {
    return (
      inst.kind === TACInstructionKind.Assignment ||
      inst.kind === TACInstructionKind.Copy ||
      inst.kind === TACInstructionKind.BinaryOp ||
      inst.kind === TACInstructionKind.UnaryOp ||
      inst.kind === TACInstructionKind.Cast
    );
  }

  private sameOperand(a: TACOperand, b: TACOperand): boolean {
    if (a.kind !== b.kind) return false;
    switch (a.kind) {
      case TACOperandKind.Variable:
        return (a as VariableOperand).name === (b as VariableOperand).name;
      case TACOperandKind.Temporary:
        return (a as TemporaryOperand).id === (b as TemporaryOperand).id;
      default:
        return false;
    }
  }

  private isCopyFromTemp(inst: TACInstruction): boolean {
    if (
      inst.kind !== TACInstructionKind.Assignment &&
      inst.kind !== TACInstructionKind.Copy
    ) {
      return false;
    }
    const { src } = inst as unknown as InstWithDestSrc;
    return src.kind === TACOperandKind.Temporary;
  }

  private rewriteProducerDest(
    inst: TACInstruction,
    newDest: TACOperand,
  ): TACInstruction {
    switch (inst.kind) {
      case TACInstructionKind.Assignment:
      case TACInstructionKind.Copy: {
        const { src } = inst as unknown as InstWithDestSrc;
        return new AssignmentInstruction(newDest, src);
      }
      case TACInstructionKind.BinaryOp: {
        const bin = inst as BinaryOpInstruction;
        return new BinaryOpInstruction(
          newDest,
          bin.left,
          bin.operator,
          bin.right,
        );
      }
      case TACInstructionKind.UnaryOp: {
        const un = inst as UnaryOpInstruction;
        return new UnaryOpInstruction(newDest, un.operator, un.operand);
      }
      case TACInstructionKind.Cast: {
        const cast = inst as CastInstruction;
        return new CastInstruction(newDest, cast.src);
      }
      default:
        return inst;
    }
  }

  private sameUdonType(a: TACOperand, b: TACOperand): boolean {
    const aType =
      (a as { type?: { udonType?: string } }).type?.udonType ?? null;
    const bType =
      (b as { type?: { udonType?: string } }).type?.udonType ?? null;
    if (!aType || !bType) return false;
    return aType === bType;
  }

  private countTempUses(instructions: TACInstruction[]): Map<number, number> {
    const counts = new Map<number, number>();
    const add = (operand: TACOperand) => {
      if (operand.kind !== TACOperandKind.Temporary) return;
      const id = (operand as TemporaryOperand).id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    };

    for (const inst of instructions) {
      for (const op of this.getUsedOperandsForReuse(inst)) {
        add(op);
      }
    }

    return counts;
  }

  private trySimplifyBinaryOp(
    inst: BinaryOpInstruction,
  ): TACInstruction | null {
    const left = inst.left;
    const right = inst.right;

    if (inst.operator === "+") {
      if (this.isZeroConstant(right)) {
        return new AssignmentInstruction(inst.dest, left);
      }
      if (this.isZeroConstant(left)) {
        return new AssignmentInstruction(inst.dest, right);
      }
    }

    if (inst.operator === "-") {
      if (this.isZeroConstant(right)) {
        return new AssignmentInstruction(inst.dest, left);
      }
    }

    if (inst.operator === "*") {
      if (this.isOneConstant(right)) {
        return new AssignmentInstruction(inst.dest, left);
      }
      if (this.isOneConstant(left)) {
        return new AssignmentInstruction(inst.dest, right);
      }
      if (this.isZeroConstant(right) || this.isZeroConstant(left)) {
        return new AssignmentInstruction(
          inst.dest,
          createConstant(0, this.getOperandType(inst.dest)),
        );
      }
    }

    if (inst.operator === "/") {
      if (this.isOneConstant(right)) {
        return new AssignmentInstruction(inst.dest, left);
      }
    }

    return null;
  }

  private trySimplifyUnaryOp(inst: UnaryOpInstruction): TACInstruction | null {
    if (inst.operator === "+") {
      return new AssignmentInstruction(inst.dest, inst.operand);
    }
    return null;
  }

  private trySimplifyCast(inst: CastInstruction): TACInstruction | null {
    const srcType = this.getOperandType(inst.src).udonType;
    const destType = this.getOperandType(inst.dest).udonType;
    if (srcType === destType) {
      return new AssignmentInstruction(inst.dest, inst.src);
    }
    return null;
  }

  private isZeroConstant(operand: TACOperand): boolean {
    return (
      operand.kind === TACOperandKind.Constant &&
      typeof (operand as ConstantOperand).value === "number" &&
      (operand as ConstantOperand).value === 0
    );
  }

  private isOneConstant(operand: TACOperand): boolean {
    return (
      operand.kind === TACOperandKind.Constant &&
      typeof (operand as ConstantOperand).value === "number" &&
      (operand as ConstantOperand).value === 1
    );
  }

  private reuseTemporaries(instructions: TACInstruction[]): TACInstruction[] {
    const tempInfo = new Map<
      number,
      { start: number; end: number; typeKey: string }
    >();

    const recordTemp = (operand: TACOperand | undefined, index: number) => {
      if (!operand || operand.kind !== TACOperandKind.Temporary) return;
      const temp = operand as TemporaryOperand;
      const typeKey = String(temp.type?.udonType ?? "Object");
      const existing = tempInfo.get(temp.id);
      if (!existing) {
        tempInfo.set(temp.id, { start: index, end: index, typeKey });
      } else {
        existing.start = Math.min(existing.start, index);
        existing.end = Math.max(existing.end, index);
      }
    };

    for (let i = 0; i < instructions.length; i++) {
      const inst = instructions[i];
      const used = this.getUsedOperandsForReuse(inst);
      for (const op of used) recordTemp(op, i);
      const defined = this.getDefinedOperandForReuse(inst);
      recordTemp(defined, i);
    }

    if (tempInfo.size === 0) return instructions;

    const intervals = Array.from(tempInfo.entries())
      .map(([id, info]) => ({
        id,
        start: info.start,
        end: info.end,
        typeKey: info.typeKey,
      }))
      .sort((a, b) => a.start - b.start || a.end - b.end);

    const freeByType = new Map<string, number[]>();
    const active: Array<{ end: number; newId: number; typeKey: string }> = [];
    const oldToNew = new Map<number, number>();
    let nextId = 0;

    const expireActive = (start: number) => {
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].end < start) {
          const expired = active[i];
          active.splice(i, 1);
          const list = freeByType.get(expired.typeKey);
          if (list) list.push(expired.newId);
          else freeByType.set(expired.typeKey, [expired.newId]);
        }
      }
    };

    for (const interval of intervals) {
      expireActive(interval.start);

      const freeList = freeByType.get(interval.typeKey);
      let newId: number;
      if (freeList && freeList.length > 0) {
        newId = freeList.pop() as number;
      } else {
        newId = nextId++;
      }

      oldToNew.set(interval.id, newId);
      active.push({
        end: interval.end,
        newId,
        typeKey: interval.typeKey,
      });
      active.sort((a, b) => a.end - b.end);
    }

    const rewriteTemp = (operand: TACOperand | undefined) => {
      if (!operand || operand.kind !== TACOperandKind.Temporary) return;
      const temp = operand as TemporaryOperand;
      const mapped = oldToNew.get(temp.id);
      if (mapped !== undefined) {
        temp.id = mapped;
      }
    };

    for (const inst of instructions) {
      const used = this.getUsedOperandsForReuse(inst);
      for (const op of used) rewriteTemp(op);
      const defined = this.getDefinedOperandForReuse(inst);
      rewriteTemp(defined);
    }

    return instructions;
  }

  private reuseLocalVariables(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const varInfo = new Map<
      string,
      { start: number; end: number; typeKey: string }
    >();
    const eligibility = new Map<string, boolean>();
    const reservedNames = new Set<string>();

    const recordVar = (operand: TACOperand | undefined, index: number) => {
      if (!operand || operand.kind !== TACOperandKind.Variable) return;
      const variable = operand as VariableOperand;
      const name = variable.name;
      reservedNames.add(name);

      const isEligible = this.isEligibleLocalVariable(variable);
      const existingEligibility = eligibility.get(name);
      if (existingEligibility === false) return;
      if (!isEligible) {
        eligibility.set(name, false);
        varInfo.delete(name);
        return;
      }

      const typeKey = String(variable.type?.udonType ?? "Object");
      const existing = varInfo.get(name);
      if (!existing) {
        eligibility.set(name, true);
        varInfo.set(name, { start: index, end: index, typeKey });
        return;
      }

      if (existing.typeKey !== typeKey) {
        eligibility.set(name, false);
        varInfo.delete(name);
        return;
      }

      existing.start = Math.min(existing.start, index);
      existing.end = Math.max(existing.end, index);
    };

    for (let i = 0; i < instructions.length; i++) {
      const inst = instructions[i];
      const used = this.getUsedOperandsForReuse(inst);
      for (const op of used) recordVar(op, i);
      const defined = this.getDefinedOperandForReuse(inst);
      recordVar(defined, i);
    }

    const intervals = Array.from(varInfo.entries())
      .filter(([name]) => eligibility.get(name) === true)
      .map(([name, info]) => ({
        name,
        start: info.start,
        end: info.end,
        typeKey: info.typeKey,
      }))
      .sort(
        (a, b) =>
          a.start - b.start || a.end - b.end || a.name.localeCompare(b.name),
      );

    if (intervals.length === 0) return instructions;

    const freeByType = new Map<string, string[]>();
    const active: Array<{ end: number; newName: string; typeKey: string }> = [];
    const oldToNew = new Map<string, string>();
    let nextId = 0;

    const allocateName = (): string => {
      let candidate = `__l${nextId++}`;
      while (reservedNames.has(candidate)) {
        candidate = `__l${nextId++}`;
      }
      reservedNames.add(candidate);
      return candidate;
    };

    const expireActive = (start: number) => {
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].end < start) {
          const expired = active[i];
          active.splice(i, 1);
          const list = freeByType.get(expired.typeKey);
          if (list) list.push(expired.newName);
          else freeByType.set(expired.typeKey, [expired.newName]);
        }
      }
    };

    for (const interval of intervals) {
      expireActive(interval.start);

      const freeList = freeByType.get(interval.typeKey);
      let newName: string;
      if (freeList && freeList.length > 0) {
        newName = freeList.pop() as string;
      } else {
        newName = allocateName();
      }

      oldToNew.set(interval.name, newName);
      active.push({ end: interval.end, newName, typeKey: interval.typeKey });
      active.sort((a, b) => a.end - b.end);
    }

    const rewriteVar = (operand: TACOperand | undefined) => {
      if (!operand || operand.kind !== TACOperandKind.Variable) return;
      const variable = operand as VariableOperand;
      const mapped = oldToNew.get(variable.name);
      if (mapped) {
        variable.name = mapped;
      }
    };

    for (const inst of instructions) {
      const used = this.getUsedOperandsForReuse(inst);
      for (const op of used) rewriteVar(op);
      const defined = this.getDefinedOperandForReuse(inst);
      rewriteVar(defined);
    }

    return instructions;
  }

  private isEligibleLocalVariable(operand: VariableOperand): boolean {
    if (!operand.isLocal) return false;
    if (operand.isParameter || operand.isExported) return false;
    const name = operand.name;
    if (name === "this" || name === "__this") return false;
    if (name === "__returnValue_return") return false;
    if (name.startsWith("__")) return false;
    return true;
  }

  /**
   * Constant folding optimization
   * Evaluate constant expressions at compile time
   */
  private constantFolding(instructions: TACInstruction[]): TACInstruction[] {
    const result: TACInstruction[] = [];

    for (const inst of instructions) {
      if (inst.kind === TACInstructionKind.Call) {
        const callInst = inst as CallInstruction;
        const folded = this.tryFoldPureExternCall(callInst);
        if (folded) {
          result.push(folded);
          continue;
        }
      }

      if (inst.kind === TACInstructionKind.Cast) {
        const castInst = inst as CastInstruction;
        const folded = this.tryFoldCastInstruction(castInst);
        if (folded) {
          result.push(folded);
          continue;
        }
      }

      if (inst.kind === TACInstructionKind.Call) {
        const callInst = inst as CallInstruction;
        const folded = this.tryFoldValueTypeConstructor(callInst);
        if (folded) {
          result.push(folded);
          continue;
        }
      }

      if (inst.kind === TACInstructionKind.BinaryOp) {
        const binOp = inst as BinaryOpInstruction;

        // Check if both operands are constants
        if (
          binOp.left.kind === TACOperandKind.Constant &&
          binOp.right.kind === TACOperandKind.Constant
        ) {
          const leftConst = binOp.left as ConstantOperand;
          const rightConst = binOp.right as ConstantOperand;

          if (
            leftConst.value === null ||
            rightConst.value === null ||
            !this.isPrimitiveFoldValue(leftConst.value) ||
            !this.isPrimitiveFoldValue(rightConst.value)
          ) {
            result.push(inst);
            continue;
          }

          // Evaluate the operation
          const foldedValue = this.evaluateBinaryOp(
            leftConst.value,
            binOp.operator,
            rightConst.value,
          );

          if (foldedValue !== null) {
            // Replace with assignment of constant
            const foldedType = ["+", "-", "*", "/"].includes(binOp.operator)
              ? leftConst.type
              : PrimitiveTypes.boolean;
            const constantOperand = createConstant(foldedValue, foldedType);
            result.push(new AssignmentInstruction(binOp.dest, constantOperand));
            continue;
          }
        }
      } else if (inst.kind === TACInstructionKind.UnaryOp) {
        const unOp = inst as UnaryOpInstruction;

        // Check if operand is constant
        if (unOp.operand.kind === TACOperandKind.Constant) {
          const constOp = unOp.operand as ConstantOperand;

          if (
            constOp.value === null ||
            !this.isPrimitiveFoldValue(constOp.value)
          ) {
            result.push(inst);
            continue;
          }

          // Evaluate the operation
          const foldedValue = this.evaluateUnaryOp(
            unOp.operator,
            constOp.value,
          );

          if (foldedValue !== null) {
            // Replace with assignment of constant
            const constantOperand = createConstant(foldedValue, constOp.type);
            result.push(new AssignmentInstruction(unOp.dest, constantOperand));
            continue;
          }
        }
      }

      // Keep instruction as-is
      result.push(inst);
    }

    return result;
  }

  /**
   * Dead code elimination
   * Remove unreachable code after unconditional jumps
   */
  private deadCodeElimination(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const result: TACInstruction[] = [];
    let unreachable = false;

    for (const inst of instructions) {
      // Label marks start of reachable code
      if (inst.kind === TACInstructionKind.Label) {
        unreachable = false;
      }

      // Skip unreachable instructions
      if (unreachable) {
        continue;
      }

      result.push(inst);

      // After unconditional jump, code is unreachable until next label
      if (
        inst.kind === TACInstructionKind.UnconditionalJump ||
        inst.kind === TACInstructionKind.Return
      ) {
        unreachable = true;
      }
    }

    return result;
  }

  private commonSubexpressionElimination(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const exprMap = new Map<string, TACOperand>();
    const result: TACInstruction[] = [];

    for (const inst of instructions) {
      if (inst.kind === TACInstructionKind.BinaryOp) {
        const bin = inst as BinaryOpInstruction;
        const key = `${bin.operator}:${this.operandKey(bin.left)}:${this.operandKey(bin.right)}`;
        const existing = exprMap.get(key);
        if (existing) {
          result.push(new CopyInstruction(bin.dest, existing));
          continue;
        }
        exprMap.set(key, bin.dest);
      }

      const assigned = this.getAssignedVariable(inst);
      if (assigned) {
        exprMap.clear();
      }

      result.push(inst);
    }

    return result;
  }

  private deadVariableElimination(
    instructions: TACInstruction[],
  ): TACInstruction[] {
    const used = new Set<string>();
    const result: TACInstruction[] = [];

    const recordUse = (operand: TACOperand): void => {
      if (operand.kind === TACOperandKind.Variable) {
        used.add((operand as unknown as { name: string }).name);
      }
    };

    for (let i = instructions.length - 1; i >= 0; i--) {
      const inst = instructions[i];
      const assigned = this.getAssignedVariable(inst);

      this.getUsedOperands(inst).forEach(recordUse);

      if (
        assigned &&
        !used.has(assigned) &&
        (inst.kind === TACInstructionKind.Assignment ||
          inst.kind === TACInstructionKind.Copy ||
          inst.kind === TACInstructionKind.Cast)
      ) {
        continue;
      }

      if (assigned) {
        used.delete(assigned);
      }
      result.push(inst);
    }

    return result.reverse();
  }

  private getAssignedVariable(inst: TACInstruction): string | null {
    if (
      inst.kind === TACInstructionKind.Assignment ||
      inst.kind === TACInstructionKind.Copy ||
      inst.kind === TACInstructionKind.BinaryOp ||
      inst.kind === TACInstructionKind.UnaryOp ||
      inst.kind === TACInstructionKind.Cast
    ) {
      const dest = (inst as unknown as InstWithDest).dest;
      if (dest && dest.kind === TACOperandKind.Variable) {
        return (dest as unknown as { name: string }).name;
      }
    }
    return null;
  }

  private getAssignedVariableName(inst: TACInstruction): string | null {
    const dest = this.getDefinedOperandForReuse(inst);
    if (dest && dest.kind === TACOperandKind.Variable) {
      return (dest as VariableOperand).name;
    }
    return null;
  }

  private getUsedOperands(inst: TACInstruction): TACOperand[] {
    switch (inst.kind) {
      case TACInstructionKind.Assignment:
      case TACInstructionKind.Copy:
        return [(inst as unknown as InstWithDestSrc).src];
      case TACInstructionKind.BinaryOp:
        return [
          (inst as BinaryOpInstruction).left,
          (inst as BinaryOpInstruction).right,
        ];
      case TACInstructionKind.UnaryOp:
        return [(inst as UnaryOpInstruction).operand];
      case TACInstructionKind.Cast:
        return [(inst as unknown as InstWithDestSrc).src];
      default:
        return [];
    }
  }

  private getUsedOperandsForReuse(inst: TACInstruction): TACOperand[] {
    switch (inst.kind) {
      case TACInstructionKind.Assignment:
      case TACInstructionKind.Copy:
      case TACInstructionKind.Cast:
        return [(inst as unknown as InstWithDestSrc).src];
      case TACInstructionKind.BinaryOp: {
        const bin = inst as BinaryOpInstruction;
        return [bin.left, bin.right];
      }
      case TACInstructionKind.UnaryOp:
        return [(inst as UnaryOpInstruction).operand];
      case TACInstructionKind.ConditionalJump:
        return [(inst as ConditionalJumpInstruction).condition];
      case TACInstructionKind.Call:
        return (inst as CallInstruction).args ?? [];
      case TACInstructionKind.MethodCall: {
        const method = inst as MethodCallInstruction;
        return [method.object, ...(method.args ?? [])];
      }
      case TACInstructionKind.PropertyGet:
        return [(inst as PropertyGetInstruction).object];
      case TACInstructionKind.PropertySet: {
        const set = inst as PropertySetInstruction;
        return [set.object, set.value];
      }
      case TACInstructionKind.Return: {
        const ret = inst as ReturnInstruction;
        return ret.value ? [ret.value] : [];
      }
      case TACInstructionKind.ArrayAccess: {
        const acc = inst as ArrayAccessInstruction;
        return [acc.array, acc.index];
      }
      case TACInstructionKind.ArrayAssignment: {
        const assign = inst as ArrayAssignmentInstruction;
        return [assign.array, assign.index, assign.value];
      }
      default:
        return [];
    }
  }

  private getDefinedOperandForReuse(
    inst: TACInstruction,
  ): TACOperand | undefined {
    switch (inst.kind) {
      case TACInstructionKind.Assignment:
      case TACInstructionKind.Copy:
      case TACInstructionKind.BinaryOp:
      case TACInstructionKind.UnaryOp:
      case TACInstructionKind.Cast:
      case TACInstructionKind.PropertyGet:
      case TACInstructionKind.ArrayAccess:
        return (inst as unknown as InstWithDest).dest;
      case TACInstructionKind.Call:
      case TACInstructionKind.MethodCall:
        return (inst as { dest?: TACOperand }).dest;
      default:
        return undefined;
    }
  }

  private operandKey(operand: TACOperand): string {
    if (operand.kind === TACOperandKind.Variable) {
      return `v:${(operand as unknown as { name: string }).name}`;
    }
    if (operand.kind === TACOperandKind.Constant) {
      return `c:${this.stringifyConstant((operand as ConstantOperand).value)}`;
    }
    if (operand.kind === TACOperandKind.Temporary) {
      return `t:${(operand as unknown as { id: number }).id}`;
    }
    return "other";
  }

  private stringifyConstant(value: unknown): string {
    return JSON.stringify(value, (_key, val) =>
      typeof val === "bigint" ? { __bigint__: val.toString() } : val,
    );
  }

  /**
   * Evaluate binary operation on constants
   */
  private evaluateBinaryOp(
    left: number | string | boolean | bigint,
    operator: string,
    right: number | string | boolean | bigint,
  ): number | boolean | string | null {
    if (typeof left === "string" && typeof right === "string") {
      if (operator === "+") return left + right;
      if (operator === "==") return left === right;
      if (operator === "!=") return left !== right;
    }

    if (typeof left === "boolean" && typeof right === "boolean") {
      if (operator === "&&") return left && right;
      if (operator === "||") return left || right;
      if (operator === "==") return left === right;
      if (operator === "!=") return left !== right;
    }

    if (typeof left === "number" && typeof right === "number") {
      switch (operator) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
        case "<":
          return left < right;
        case ">":
          return left > right;
        case "<=":
          return left <= right;
        case ">=":
          return left >= right;
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        default:
          return null;
      }
    }

    const isNumericLike = (
      value: number | string | boolean | bigint,
    ): value is number | boolean =>
      typeof value === "number" || typeof value === "boolean";

    if (isNumericLike(left) && isNumericLike(right)) {
      const leftNum = typeof left === "number" ? left : left ? 1 : 0;
      const rightNum = typeof right === "number" ? right : right ? 1 : 0;
      if (operator === "<") return leftNum < rightNum;
      if (operator === ">") return leftNum > rightNum;
      if (operator === "<=") return leftNum <= rightNum;
      if (operator === ">=") return leftNum >= rightNum;
      if (operator === "==") return leftNum === rightNum;
      if (operator === "!=") return leftNum !== rightNum;
    }

    return null;
  }

  /**
   * Evaluate unary operation on constant
   */
  private evaluateUnaryOp(
    operator: string,
    operand: number | string | boolean | bigint,
  ): number | boolean | bigint | null {
    if (operator === "-" && typeof operand === "number") {
      return -operand;
    }
    if (operator === "!" && typeof operand === "boolean") {
      return !operand;
    }
    if (operator === "~") {
      if (typeof operand === "number") {
        return ~operand;
      }
      if (typeof operand === "bigint") {
        return ~operand;
      }
    }
    return null;
  }

  private tryFoldCastInstruction(inst: CastInstruction): TACInstruction | null {
    if (inst.src.kind !== TACOperandKind.Constant) return null;
    const srcConst = inst.src as ConstantOperand;
    if (srcConst.value === null || !this.isPrimitiveFoldValue(srcConst.value)) {
      return null;
    }

    const destType = this.getOperandType(inst.dest);
    const castValue = this.evaluateCastValue(srcConst.value, destType);
    if (castValue === null) return null;

    return new AssignmentInstruction(
      inst.dest,
      createConstant(castValue, destType),
    );
  }

  private tryFoldValueTypeConstructor(
    inst: CallInstruction,
  ): TACInstruction | null {
    if (!inst.dest) return null;
    if (inst.func !== "__ctor_Vector3" && inst.func !== "__ctor_Color") {
      return null;
    }
    if (inst.args.length === 0) return null;

    const numericArgs: number[] = [];
    for (const arg of inst.args) {
      if (arg.kind !== TACOperandKind.Constant) return null;
      const constArg = arg as ConstantOperand;
      if (typeof constArg.value !== "number") return null;
      numericArgs.push(constArg.value);
    }

    let foldedValue: Record<string, number> | null = null;
    if (inst.func === "__ctor_Vector3") {
      if (numericArgs.length !== 3) return null;
      foldedValue = {
        x: numericArgs[0],
        y: numericArgs[1],
        z: numericArgs[2],
      };
    }

    if (inst.func === "__ctor_Color") {
      if (numericArgs.length < 3) return null;
      foldedValue = {
        r: numericArgs[0],
        g: numericArgs[1],
        b: numericArgs[2],
        a: numericArgs[3] ?? 1,
      };
    }

    if (!foldedValue) return null;
    const destType = this.getOperandType(inst.dest);
    return new AssignmentInstruction(
      inst.dest,
      createConstant(foldedValue, destType),
    );
  }

  private tryFoldPureExternCall(inst: CallInstruction): TACInstruction | null {
    if (!inst.dest) return null;
    const evaluator = TACOptimizer.pureExternEvaluators.get(inst.func);
    if (!evaluator) return null;
    if (inst.args.length !== evaluator.arity) return null;

    const args: number[] = [];
    for (const arg of inst.args) {
      if (arg.kind !== TACOperandKind.Constant) return null;
      const constArg = arg as ConstantOperand;
      if (typeof constArg.value !== "number") return null;
      if (!Number.isFinite(constArg.value)) return null;
      args.push(constArg.value);
    }

    const result = evaluator.eval(args);
    if (!Number.isFinite(result)) return null;

    const destType = this.getOperandType(inst.dest);
    const casted = this.evaluateCastValue(result, destType);
    if (casted === null || typeof casted !== "number") return null;

    return new AssignmentInstruction(
      inst.dest,
      createConstant(casted, destType),
    );
  }

  private evaluateCastValue(
    value: number | string | boolean | bigint,
    targetType: TypeSymbol,
  ): number | string | boolean | bigint | null {
    const target = targetType.udonType;

    if (target === "Boolean") {
      return Boolean(value);
    }

    if (target === "String") {
      return String(value);
    }

    if (target === "Int64" || target === "UInt64") {
      try {
        if (typeof value === "bigint") return value;
        if (typeof value === "number") return BigInt(Math.trunc(value));
        if (typeof value === "boolean") return value ? 1n : 0n;
        if (typeof value === "string") return BigInt(value);
      } catch {
        return null;
      }
    }

    if (this.isNumericUdonType(target)) {
      let numeric: number;
      if (typeof value === "number") {
        numeric = value;
      } else if (typeof value === "boolean") {
        numeric = value ? 1 : 0;
      } else if (typeof value === "string") {
        numeric = Number(value);
      } else if (typeof value === "bigint") {
        numeric = Number(value);
      } else {
        return null;
      }

      if (Number.isNaN(numeric)) return null;

      if (this.isIntegerUdonType(target)) {
        if (target === "UInt32") {
          return numeric >>> 0;
        }
        return Math.trunc(numeric);
      }

      return numeric;
    }

    return null;
  }

  private getOperandType(operand: TACOperand): TypeSymbol {
    if (
      operand.kind === TACOperandKind.Variable ||
      operand.kind === TACOperandKind.Constant ||
      operand.kind === TACOperandKind.Temporary
    ) {
      return (operand as unknown as { type: TypeSymbol }).type;
    }
    return PrimitiveTypes.single;
  }

  private isNumericUdonType(typeName: string): boolean {
    return this.isIntegerUdonType(typeName) || this.isFloatUdonType(typeName);
  }

  private isFloatUdonType(typeName: string): boolean {
    return typeName === "Single" || typeName === "Double";
  }

  private isIntegerUdonType(typeName: string): boolean {
    return (
      typeName === "Byte" ||
      typeName === "SByte" ||
      typeName === "Int16" ||
      typeName === "UInt16" ||
      typeName === "Int32" ||
      typeName === "UInt32" ||
      typeName === "Int64" ||
      typeName === "UInt64"
    );
  }

  private isPrimitiveFoldValue(
    value: ConstantValue,
  ): value is number | string | boolean | bigint {
    const type = typeof value;
    return (
      type === "number" ||
      type === "string" ||
      type === "boolean" ||
      type === "bigint"
    );
  }

  private isCopyOnWriteCandidateType(type: TypeSymbol): boolean {
    const udonType = type.udonType;
    if (udonType === "Boolean" || udonType === "String") return false;
    if (this.isNumericUdonType(udonType)) return false;
    return true;
  }
}

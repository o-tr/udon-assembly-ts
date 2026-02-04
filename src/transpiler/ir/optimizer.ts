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
  type ConditionalJumpInstruction,
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

type BasicBlock = {
  id: number;
  start: number;
  end: number;
  preds: number[];
  succs: number[];
};

/**
 * TAC optimizer
 */
export class TACOptimizer {
  /**
   * Apply all optimization passes
   */
  optimize(instructions: TACInstruction[]): TACInstruction[] {
    let optimized = instructions;

    // Apply constant folding
    optimized = this.constantFolding(optimized);

    // Apply CFG-based constant and copy propagation
    optimized = this.cfgPropagateConstantsAndCopies(optimized);

    // Apply common subexpression elimination
    optimized = this.commonSubexpressionElimination(optimized);

    // Apply algebraic simplifications and redundant cast removal
    optimized = this.algebraicSimplification(optimized);

    // Simplify branches based on constant conditions
    optimized = this.simplifyBranches(optimized);

    // Eliminate single-use temporaries inside basic blocks
    optimized = this.eliminateSingleUseTemporaries(optimized);

    // Remove unused variable assignments
    optimized = this.deadVariableElimination(optimized);

    // Apply dead code elimination
    optimized = this.deadCodeElimination(optimized);

    // Apply copy-on-write temporary reuse to reduce heap usage
    optimized = this.copyOnWriteTemporaries(optimized);

    // Reuse temporary variables to reduce heap usage
    optimized = this.reuseTemporaries(optimized);

    // Reuse local variables when lifetimes do not overlap
    optimized = this.reuseLocalVariables(optimized);

    return optimized;
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
          if (typeof value === "boolean" || typeof value === "number") {
            if (value) {
              result.push(new UnconditionalJumpInstruction(condJump.label));
              continue;
            }
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

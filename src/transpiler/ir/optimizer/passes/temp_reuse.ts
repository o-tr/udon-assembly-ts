import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  type ArrayAccessInstruction,
  type ArrayAssignmentInstruction,
  AssignmentInstruction,
  type BinaryOpInstruction,
  type CallInstruction,
  CastInstruction,
  type ConditionalJumpInstruction,
  CopyInstruction,
  type MethodCallInstruction,
  type PropertyGetInstruction,
  type PropertySetInstruction,
  type ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  type UnaryOpInstruction,
} from "../../tac_instruction.js";
import type { TemporaryOperand, VariableOperand } from "../../tac_operand.js";
import {
  createTemporary,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import {
  countTempUses,
  getDefinedOperandForReuse,
  getUsedOperandsForReuse,
  type InstWithDest,
  type InstWithDestSrc,
  isCopyFromTemp,
  isPureProducer,
  rewriteOperands,
  rewriteProducerDest,
} from "../utils/instructions.js";
import { pureExternEvaluators } from "../utils/pure_extern.js";
import { sameUdonType } from "../utils/operands.js";
import { getOperandType } from "./constant_folding.js";

export const copyOnWriteTemporaries = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  let maxTempId = -1;
  const recordTemp = (operand: TACOperand | undefined) => {
    if (!operand || operand.kind !== TACOperandKind.Temporary) return;
    const temp = operand as TemporaryOperand;
    if (temp.id > maxTempId) maxTempId = temp.id;
  };

  for (const inst of instructions) {
    const used = getUsedOperandsForReuse(inst);
    for (const operand of used) recordTemp(operand);
    const defined = getDefinedOperandForReuse(inst);
    recordTemp(defined);
  }

  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;
  const blocksInOrder = Array.from(cfg.blocks).sort(
    (a, b) => a.start - b.start,
  );
  const isStraightLine = blocksInOrder.every((block, index) => {
    if (index === 0) {
      if (block.preds.length !== 0) return false;
    } else {
      const prev = blocksInOrder[index - 1];
      if (block.preds.length !== 1 || block.preds[0] !== prev.id) {
        return false;
      }
    }
    if (index === blocksInOrder.length - 1) {
      if (block.succs.length !== 0) return false;
    } else {
      const next = blocksInOrder[index + 1];
      if (block.succs.length !== 1 || block.succs[0] !== next.id) {
        return false;
      }
    }
    return true;
  });
  if (!isStraightLine) return instructions;

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
          (call as CallInstruction).isTailCall ?? false,
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
          (call as MethodCallInstruction).isTailCall ?? false,
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
    const targetType = getOperandType(call.object);
    return isCopyOnWriteCandidateType(targetType);
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
        getOperandType(dest).udonType === getOperandType(resolvedSrc).udonType
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
          getOperandType(set.object),
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
          getOperandType(assign.array),
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
          getOperandType(call.object),
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
      const defined = getDefinedOperandForReuse(rewritten);
      if (defined?.kind === TACOperandKind.Temporary) {
        resetAlias(defined as TemporaryOperand);
      }
      continue;
    }

    const rewritten = rewriteInstruction(inst);
    result.push(rewritten);
    const defined = getDefinedOperandForReuse(rewritten);
    if (defined?.kind === TACOperandKind.Temporary) {
      resetAlias(defined as TemporaryOperand);
    }
  }

  return result;
};

export const eliminateSingleUseTemporaries = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  const result: TACInstruction[] = [];

  for (const block of cfg.blocks) {
    const blockInstructions = instructions.slice(block.start, block.end + 1);
    const tempUseCounts = countTempUses(blockInstructions);

    for (let i = 0; i < blockInstructions.length; i++) {
      const inst = blockInstructions[i];
      const next = blockInstructions[i + 1];

      if (next && isCopyFromTemp(next)) {
        // Only allow forwarding when the producer is pure. For calls we
        // restrict to known pure externs; method calls are considered
        // impure by default and are not allowed here.
        const isAllowedProducer =
          isPureProducer(inst) ||
          (inst.kind === TACInstructionKind.Call &&
            pureExternEvaluators.has((inst as unknown as CallInstruction).func));

        if (!isAllowedProducer) {
          result.push(inst);
          continue;
        }

        const destTemp = (inst as unknown as InstWithDest).dest;
        if (
          destTemp &&
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
            // Only forward into plain local variables; avoid rewriting into
            // properties/array elements which could change observable
            // behavior for impure calls.
            if (
              nextDest.kind === TACOperandKind.Variable &&
              isEligibleLocalVariable(nextDest as VariableOperand) &&
              sameUdonType(destTemp, nextDest)
            ) {
              const rewritten = rewriteProducerDest(inst, nextDest);
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
};

export const reuseTemporaries = (
  instructions: TACInstruction[],
): TACInstruction[] => {
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
    const used = getUsedOperandsForReuse(inst);
    for (const op of used) recordTemp(op, i);
    const defined = getDefinedOperandForReuse(inst);
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

  const rewriteTemp = (operand: TACOperand): TACOperand => {
    if (operand.kind !== TACOperandKind.Temporary) return operand;
    const temp = operand as TemporaryOperand;
    const mapped = oldToNew.get(temp.id);
    if (mapped === undefined || mapped === temp.id) return operand;
    return createTemporary(mapped, temp.type);
  };

  for (const inst of instructions) {
    rewriteOperands(inst, rewriteTemp);
  }

  return instructions;
};

export const reuseLocalVariables = (
  instructions: TACInstruction[],
): TACInstruction[] => {
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

    const isEligible = isEligibleLocalVariable(variable);
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
    const used = getUsedOperandsForReuse(inst);
    for (const op of used) recordVar(op, i);
    const defined = getDefinedOperandForReuse(inst);
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

  const rewriteVar = (operand: TACOperand): TACOperand => {
    if (operand.kind !== TACOperandKind.Variable) return operand;
    const variable = operand as VariableOperand;
    const mapped = oldToNew.get(variable.name);
    if (!mapped || mapped === variable.name) return operand;
    return { ...variable, name: mapped } as VariableOperand;
  };

  for (const inst of instructions) {
    rewriteOperands(inst, rewriteVar);
  }

  return instructions;
};

export const isEligibleLocalVariable = (operand: VariableOperand): boolean => {
  if (!operand.isLocal) return false;
  if (operand.isParameter || operand.isExported) return false;
  const name = operand.name;
  if (name === "this" || name === "__this") return false;
  if (name === "__returnValue_return") return false;
  if (name.startsWith("__")) return false;
  return true;
};

export const isCopyOnWriteCandidateType = (type: TypeSymbol): boolean => {
  const udonType = type.udonType;
  return udonType === "DataList" || udonType === "DataDictionary";
};

import { resolveExternSignature } from "../../../codegen/extern_signatures.js";
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
import { sameUdonType } from "../utils/operands.js";
import { pureExternEvaluators } from "../utils/pure_extern.js";
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

  const isUdonExternSignature = (signature: string): boolean => {
    return /^[A-Za-z0-9._]+\.__[A-Za-z0-9_]+__(?:[A-Za-z0-9_]+)?__[A-Za-z0-9_]+$/.test(
      signature,
    );
  };

  const resolvePureExternSignature = (func: string): string | null => {
    if (isUdonExternSignature(func)) return func;
    const lastDot = func.lastIndexOf(".");
    if (lastDot <= 0) return null;
    const typeName = func.slice(0, lastDot);
    const memberName = func.slice(lastDot + 1);
    return resolveExternSignature(typeName, memberName, "method");
  };

  const isPureExternCall = (call: CallInstruction): boolean => {
    const resolved = resolvePureExternSignature(call.func);
    return resolved ? pureExternEvaluators.has(resolved) : false;
  };

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
            isPureExternCall(inst as CallInstruction));

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
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  // Collect all temp ids and their types
  const tempTypes = new Map<number, string>();
  const ineligible = new Set<number>();
  for (const inst of instructions) {
    const collectTemp = (operand: TACOperand | undefined) => {
      if (!operand || operand.kind !== TACOperandKind.Temporary) return;
      const temp = operand as TemporaryOperand;
      const typeKey = String(temp.type?.udonType ?? "Object");
      const existing = tempTypes.get(temp.id);
      if (existing !== undefined) {
        if (existing !== typeKey) ineligible.add(temp.id);
      } else {
        tempTypes.set(temp.id, typeKey);
      }
    };
    for (const op of getUsedOperandsForReuse(inst)) collectTemp(op);
    collectTemp(getDefinedOperandForReuse(inst));
  }

  // Remove temps with inconsistent types across occurrences
  for (const id of ineligible) tempTypes.delete(id);

  if (tempTypes.size === 0) return instructions;

  // 1. Compute def/use sets per block
  // def[b] = temps defined in block b before any use
  // use[b] = temps used in block b before any definition
  const blockDef: Map<number, Set<number>> = new Map();
  const blockUse: Map<number, Set<number>> = new Map();

  for (const block of cfg.blocks) {
    const def = new Set<number>();
    const use = new Set<number>();

    for (let i = block.start; i <= block.end; i++) {
      const inst = instructions[i];

      // Record uses first (before def kills them)
      for (const op of getUsedOperandsForReuse(inst)) {
        if (op.kind === TACOperandKind.Temporary) {
          const id = (op as TemporaryOperand).id;
          if (!def.has(id)) use.add(id);
        }
      }

      // Then record def
      const defined = getDefinedOperandForReuse(inst);
      if (defined?.kind === TACOperandKind.Temporary) {
        const id = (defined as TemporaryOperand).id;
        def.add(id);
      }
    }

    blockDef.set(block.id, def);
    blockUse.set(block.id, use);
  }

  // 2. Backward dataflow: compute liveIn/liveOut per block
  const liveIn: Map<number, Set<number>> = new Map();
  const liveOut: Map<number, Set<number>> = new Map();
  for (const block of cfg.blocks) {
    liveIn.set(block.id, new Set());
    liveOut.set(block.id, new Set());
  }

  let changed = true;
  while (changed) {
    changed = false;
    // Process blocks in reverse order for faster convergence
    for (let bi = cfg.blocks.length - 1; bi >= 0; bi--) {
      const block = cfg.blocks[bi];

      // liveOut[b] = ∪ liveIn[s] for s in succs[b]
      const newLiveOut = new Set<number>();
      for (const succId of block.succs) {
        const succLiveIn = liveIn.get(succId);
        if (succLiveIn) {
          for (const id of succLiveIn) {
            newLiveOut.add(id);
          }
        }
      }

      // liveIn[b] = use[b] ∪ (liveOut[b] - def[b])
      const def = blockDef.get(block.id) ?? new Set<number>();
      const use = blockUse.get(block.id) ?? new Set<number>();
      const newLiveIn = new Set(use);
      for (const id of newLiveOut) {
        if (!def.has(id)) newLiveIn.add(id);
      }

      const oldLiveIn = liveIn.get(block.id) ?? new Set<number>();
      const oldLiveOut = liveOut.get(block.id) ?? new Set<number>();
      let blockChanged = false;
      if (
        newLiveIn.size !== oldLiveIn.size ||
        newLiveOut.size !== oldLiveOut.size
      ) {
        blockChanged = true;
      } else {
        for (const id of newLiveIn) {
          if (!oldLiveIn.has(id)) {
            blockChanged = true;
            break;
          }
        }
        if (!blockChanged) {
          for (const id of newLiveOut) {
            if (!oldLiveOut.has(id)) {
              blockChanged = true;
              break;
            }
          }
        }
      }
      if (blockChanged) {
        changed = true;
        liveIn.set(block.id, newLiveIn);
        liveOut.set(block.id, newLiveOut);
      }
    }
  }

  // 3. Build interference graph: two temps interfere if simultaneously live
  // Walk through each block instruction-by-instruction, tracking the live set
  const interference = new Map<number, Set<number>>();
  for (const id of tempTypes.keys()) {
    interference.set(id, new Set());
  }

  for (const block of cfg.blocks) {
    // Start with liveOut of the block, walk backward
    const live = new Set(liveOut.get(block.id) ?? []);

    for (let i = block.end; i >= block.start; i--) {
      const inst = instructions[i];

      // At a definition point, the defined temp interferes with all currently live temps
      const defined = getDefinedOperandForReuse(inst);
      if (defined?.kind === TACOperandKind.Temporary) {
        const defId = (defined as TemporaryOperand).id;
        // The defined temp interferes with all live temps (except itself)
        for (const liveId of live) {
          if (liveId !== defId) {
            interference.get(defId)?.add(liveId);
            interference.get(liveId)?.add(defId);
          }
        }
        // Remove defined temp from live (it's dead above this point unless used)
        live.delete(defId);
      }

      // Add used temps to live set
      for (const op of getUsedOperandsForReuse(inst)) {
        if (op.kind === TACOperandKind.Temporary) {
          live.add((op as TemporaryOperand).id);
        }
      }
    }
  }

  // 4. Greedy graph coloring: assign temps of the same type to reusable slots
  // Sort temps by number of interferences (most constrained first)
  const tempIds = Array.from(tempTypes.keys()).sort((a, b) => {
    const aSize = interference.get(a)?.size ?? 0;
    const bSize = interference.get(b)?.size ?? 0;
    return bSize - aSize || a - b;
  });

  const oldToNew = new Map<number, number>();
  let nextId = 0;
  // Maps each allocated color to the type it was first assigned to.
  // A color must not be shared across different types.
  const colorType = new Map<number, string>();

  for (const tempId of tempIds) {
    const typeKey = tempTypes.get(tempId) ?? "Object";
    const neighbors = interference.get(tempId) ?? new Set<number>();

    // Collect colors that cannot be reused: those held by interfering neighbors
    const usedColors = new Set<number>();
    for (const neighborId of neighbors) {
      const color = oldToNew.get(neighborId);
      if (color !== undefined) usedColors.add(color);
    }

    // Find the smallest color that is (a) not used by a neighbor and
    // (b) not already assigned to a different type.
    let color = 0;
    while (
      usedColors.has(color) ||
      (colorType.has(color) && colorType.get(color) !== typeKey)
    ) {
      color++;
    }

    if (color >= nextId) nextId = color + 1;
    colorType.set(color, typeKey);
    oldToNew.set(tempId, color);
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

  return [...instructions];
};

export const reuseLocalVariables = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  // Collect eligible variables and their types, plus reserved names
  const varTypes = new Map<string, string>();
  const eligibility = new Map<string, boolean>();
  const reservedNames = new Set<string>();

  for (const inst of instructions) {
    const processOperand = (operand: TACOperand | undefined) => {
      if (!operand || operand.kind !== TACOperandKind.Variable) return;
      const variable = operand as VariableOperand;
      const name = variable.name;
      reservedNames.add(name);

      const existingEligibility = eligibility.get(name);
      if (existingEligibility === false) return;

      if (!isEligibleLocalVariable(variable)) {
        eligibility.set(name, false);
        varTypes.delete(name);
        return;
      }

      const typeKey = String(variable.type?.udonType ?? "Object");
      const existingType = varTypes.get(name);
      if (existingType !== undefined && existingType !== typeKey) {
        eligibility.set(name, false);
        varTypes.delete(name);
        return;
      }

      eligibility.set(name, true);
      varTypes.set(name, typeKey);
    };

    for (const op of getUsedOperandsForReuse(inst)) processOperand(op);
    processOperand(getDefinedOperandForReuse(inst));
  }

  const eligibleVars = new Set(
    Array.from(eligibility.entries())
      .filter(([, v]) => v)
      .map(([k]) => k),
  );

  if (eligibleVars.size === 0) return instructions;

  // 1. Compute def/use sets per block for eligible variables
  const blockDef: Map<number, Set<string>> = new Map();
  const blockUse: Map<number, Set<string>> = new Map();

  for (const block of cfg.blocks) {
    const def = new Set<string>();
    const use = new Set<string>();

    for (let i = block.start; i <= block.end; i++) {
      const inst = instructions[i];

      for (const op of getUsedOperandsForReuse(inst)) {
        if (op.kind === TACOperandKind.Variable) {
          const name = (op as VariableOperand).name;
          if (eligibleVars.has(name) && !def.has(name)) use.add(name);
        }
      }

      const defined = getDefinedOperandForReuse(inst);
      if (defined?.kind === TACOperandKind.Variable) {
        const name = (defined as VariableOperand).name;
        if (eligibleVars.has(name)) def.add(name);
      }
    }

    blockDef.set(block.id, def);
    blockUse.set(block.id, use);
  }

  // 2. Backward dataflow: compute liveIn/liveOut per block
  const liveIn: Map<number, Set<string>> = new Map();
  const liveOut: Map<number, Set<string>> = new Map();
  for (const block of cfg.blocks) {
    liveIn.set(block.id, new Set());
    liveOut.set(block.id, new Set());
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let bi = cfg.blocks.length - 1; bi >= 0; bi--) {
      const block = cfg.blocks[bi];

      const newLiveOut = new Set<string>();
      for (const succId of block.succs) {
        const succLiveIn = liveIn.get(succId);
        if (succLiveIn) {
          for (const name of succLiveIn) {
            newLiveOut.add(name);
          }
        }
      }

      const def = blockDef.get(block.id) ?? new Set<string>();
      const use = blockUse.get(block.id) ?? new Set<string>();
      const newLiveIn = new Set(use);
      for (const name of newLiveOut) {
        if (!def.has(name)) newLiveIn.add(name);
      }

      const oldLiveIn = liveIn.get(block.id) ?? new Set<string>();
      const oldLiveOut = liveOut.get(block.id) ?? new Set<string>();
      let blockChanged = false;
      if (
        newLiveIn.size !== oldLiveIn.size ||
        newLiveOut.size !== oldLiveOut.size
      ) {
        blockChanged = true;
      } else {
        for (const name of newLiveIn) {
          if (!oldLiveIn.has(name)) {
            blockChanged = true;
            break;
          }
        }
        if (!blockChanged) {
          for (const name of newLiveOut) {
            if (!oldLiveOut.has(name)) {
              blockChanged = true;
              break;
            }
          }
        }
      }
      if (blockChanged) {
        changed = true;
        liveIn.set(block.id, newLiveIn);
        liveOut.set(block.id, newLiveOut);
      }
    }
  }

  // 3. Build interference graph
  const interference = new Map<string, Set<string>>();
  for (const name of eligibleVars) {
    interference.set(name, new Set());
  }

  for (const block of cfg.blocks) {
    const live = new Set(liveOut.get(block.id) ?? []);

    for (let i = block.end; i >= block.start; i--) {
      const inst = instructions[i];

      const defined = getDefinedOperandForReuse(inst);
      if (defined?.kind === TACOperandKind.Variable) {
        const defName = (defined as VariableOperand).name;
        if (eligibleVars.has(defName)) {
          for (const liveName of live) {
            if (liveName !== defName) {
              interference.get(defName)?.add(liveName);
              interference.get(liveName)?.add(defName);
            }
          }
          live.delete(defName);
        }
      }

      for (const op of getUsedOperandsForReuse(inst)) {
        if (op.kind === TACOperandKind.Variable) {
          const name = (op as VariableOperand).name;
          if (eligibleVars.has(name)) live.add(name);
        }
      }
    }
  }

  // 4. Greedy graph coloring
  const sortedVars = Array.from(eligibleVars).sort((a, b) => {
    const aSize = interference.get(a)?.size ?? 0;
    const bSize = interference.get(b)?.size ?? 0;
    return bSize - aSize || a.localeCompare(b);
  });

  let nextId = 0;
  const allocateName = (): string => {
    let candidate = `__l${nextId++}`;
    while (reservedNames.has(candidate)) {
      candidate = `__l${nextId++}`;
    }
    reservedNames.add(candidate);
    return candidate;
  };

  const oldToNew = new Map<string, string>();
  const oldToColor = new Map<string, number>();
  const colorToName = new Map<string, Map<number, string>>(); // typeKey -> (color -> name)

  for (const varName of sortedVars) {
    const typeKey = varTypes.get(varName) ?? "Object";
    const neighbors = interference.get(varName) ?? new Set<string>();

    // Collect colors used by same-type neighbors via direct lookup
    const usedColors = new Set<number>();
    for (const neighborName of neighbors) {
      if (varTypes.get(neighborName) === typeKey) {
        const neighborColor = oldToColor.get(neighborName);
        if (neighborColor !== undefined) usedColors.add(neighborColor);
      }
    }

    let color = 0;
    while (usedColors.has(color)) color++;

    let typeColors = colorToName.get(typeKey);
    if (!typeColors) {
      typeColors = new Map();
      colorToName.set(typeKey, typeColors);
    }

    let assignedName = typeColors.get(color);
    if (!assignedName) {
      assignedName = allocateName();
      typeColors.set(color, assignedName);
    }

    oldToColor.set(varName, color);
    oldToNew.set(varName, assignedName);
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

  return [...instructions];
};

export const isEligibleLocalVariable = (operand: VariableOperand): boolean => {
  if (!operand.isLocal) return false;
  if (operand.isParameter || operand.isExported) return false;
  const name = operand.name;
  if (name === "this" || name === "__this") return false;
  if (name === "__returnValue_return") return false;
  // Exclude specific __ patterns that must not be reused
  if (name.startsWith("__inst_")) return false;
  if (name.startsWith("__recursionStack_")) return false;
  if (name.startsWith("__prev_")) return false;
  if (name === "__gameObject" || name === "__transform") return false;
  // Other __ variables (scoped locals like __0_*, __l*) are eligible
  return true;
};

export const isCopyOnWriteCandidateType = (type: TypeSymbol): boolean => {
  const udonType = type.udonType;
  return udonType === "DataList" || udonType === "DataDictionary";
};

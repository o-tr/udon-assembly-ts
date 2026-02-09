import { resolveExternSignature } from "../../../codegen/extern_signatures.js";
import { PrimitiveTypes } from "../../../frontend/type_symbols.js";
import {
  BinaryOpInstruction,
  CallInstruction,
  CastInstruction,
  CopyInstruction,
  PropertyGetInstruction,
  type TACInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import {
  createTemporary,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import { isIdempotentMethod } from "../utils/idempotent_methods.js";
import {
  getDefinedOperandForReuse,
  getMaxTempId,
  getUsedOperandsForReuse,
} from "../utils/instructions.js";
import { livenessKey, livenessKeyWithSSA } from "../utils/liveness.js";
import { operandKey, operandKeyWithSSA } from "../utils/operands.js";
import { pureExternEvaluators } from "../utils/pure_extern.js";
import { getOperandType } from "./constant_folding.js";

const isSideEffectBarrier = (inst: TACInstruction): boolean => {
  return (
    inst.kind === TACInstructionKind.Call ||
    inst.kind === TACInstructionKind.MethodCall ||
    inst.kind === TACInstructionKind.PropertySet ||
    inst.kind === TACInstructionKind.ArrayAssignment
  );
};

const isCommutativeOperator = (op: string): boolean => {
  return op === "+" || op === "*" || op === "==" || op === "!=";
};

const binaryExprKey = (
  inst: BinaryOpInstruction,
  keyForOperand: (operand: TACOperand) => string,
): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  let leftKey = keyForOperand(inst.left);
  let rightKey = keyForOperand(inst.right);
  const commutative =
    inst.operator === "+" && typeKey === PrimitiveTypes.string.udonType
      ? false
      : isCommutativeOperator(inst.operator);
  if (commutative && leftKey > rightKey) {
    const tmp = leftKey;
    leftKey = rightKey;
    rightKey = tmp;
  }
  return `bin|${inst.operator}|${leftKey}|${rightKey}|${typeKey}|`;
};

const castExprKey = (
  inst: CastInstruction,
  keyForOperand: (operand: TACOperand) => string,
): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  const srcKey = keyForOperand(inst.src);
  return `cast|${srcKey}|${typeKey}|`;
};

const propertyGetExprKeyForPRE = (
  inst: PropertyGetInstruction,
  keyForOperand: (operand: TACOperand) => string,
): string | null => {
  const objectTypeName = getOperandType(inst.object).name;
  const returnTypeName = getOperandType(inst.dest).name;
  const signature = resolveExternSignature(
    objectTypeName,
    inst.property,
    "getter",
    [],
    returnTypeName,
  );
  if (!signature || !isIdempotentMethod(signature)) return null;
  const typeKey = getOperandType(inst.dest).udonType;
  const objectKeyStr = keyForOperand(inst.object);
  return `propget_idem|${objectKeyStr}|${inst.property}|${typeKey}|`;
};

const callExprKeyForPRE = (
  inst: CallInstruction,
  keyForOperand: (operand: TACOperand) => string,
): string | null => {
  if (!inst.dest) return null;
  if (!pureExternEvaluators.has(inst.func)) return null;
  const typeKey = getOperandType(inst.dest).udonType;
  const argKeys = inst.args.map((arg) => keyForOperand(arg)).join("|");
  const tailFlag = (inst as CallInstruction).isTailCall ? 1 : 0;
  return `purecall|${inst.func}|${argKeys}|${typeKey}|tail:${tailFlag}|`;
};

/**
 * Compute a PRE-compatible expression key for an instruction, or null
 * if the instruction is not a PRE candidate.
 */
const exprKey = (
  inst: TACInstruction,
  keyForOperand: (operand: TACOperand) => string,
): string | null => {
  switch (inst.kind) {
    case TACInstructionKind.BinaryOp:
      return binaryExprKey(inst as BinaryOpInstruction, keyForOperand);
    case TACInstructionKind.Cast:
      return castExprKey(inst as CastInstruction, keyForOperand);
    case TACInstructionKind.PropertyGet:
      return propertyGetExprKeyForPRE(
        inst as PropertyGetInstruction,
        keyForOperand,
      );
    case TACInstructionKind.Call:
      return callExprKeyForPRE(inst as CallInstruction, keyForOperand);
    default:
      return null;
  }
};

/**
 * Get the read operands for a PRE-candidate expression.
 */
const getExprOperands = (inst: TACInstruction): TACOperand[] => {
  switch (inst.kind) {
    case TACInstructionKind.BinaryOp: {
      const bin = inst as BinaryOpInstruction;
      return [bin.left, bin.right];
    }
    case TACInstructionKind.Cast:
      return [(inst as CastInstruction).src];
    case TACInstructionKind.PropertyGet:
      return [(inst as PropertyGetInstruction).object];
    case TACInstructionKind.Call:
      return [...(inst as CallInstruction).args];
    default:
      return [];
  }
};

/**
 * Get the dest operand for a PRE-candidate expression.
 */
const getExprDest = (inst: TACInstruction): TACOperand | undefined => {
  return getDefinedOperandForReuse(inst);
};

/**
 * Clone a PRE-candidate instruction with a new dest.
 */
const cloneExprWithDest = (
  inst: TACInstruction,
  newDest: TACOperand,
): TACInstruction => {
  switch (inst.kind) {
    case TACInstructionKind.BinaryOp: {
      const bin = inst as BinaryOpInstruction;
      return new BinaryOpInstruction(
        newDest,
        bin.left,
        bin.operator,
        bin.right,
      );
    }
    case TACInstructionKind.Cast:
      return new CastInstruction(newDest, (inst as CastInstruction).src);
    case TACInstructionKind.PropertyGet: {
      const get = inst as PropertyGetInstruction;
      return new PropertyGetInstruction(newDest, get.object, get.property);
    }
    case TACInstructionKind.Call: {
      const call = inst as CallInstruction;
      return new CallInstruction(newDest, call.func, [...call.args]);
    }
    default:
      return inst;
  }
};

type ExprValue = { key: string; inst: TACInstruction };

const computeAvailableMaps = (
  instructions: TACInstruction[],
  options?: { useSSA?: boolean },
): {
  inMaps: Map<number, Map<string, ExprValue>>;
  outMaps: Map<number, Map<string, ExprValue>>;
} => {
  const useSSA = options?.useSSA === true;
  const keyForOperand = useSSA ? operandKeyWithSSA : operandKey;
  const liveKey = useSSA ? livenessKeyWithSSA : livenessKey;
  const cfg = buildCFG(instructions);
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
      if (block.id === 0) {
        inMaps.set(block.id, new Map());
      } else {
        const predMaps = block.preds.map((id) => outMaps.get(id) ?? new Map());
        let merged = new Map<string, ExprValue>();
        if (predMaps.length > 0) {
          const [first, ...rest] = predMaps;
          merged = new Map(first);
          for (const [key, value] of Array.from(merged.entries())) {
            if (rest.some((map) => map.get(key)?.key !== value.key)) {
              merged.delete(key);
            }
          }
        }
        inMaps.set(block.id, merged);
      }

      const working = new Map(inMaps.get(block.id) ?? new Map());
      for (let i = block.start; i <= block.end; i += 1) {
        const inst = instructions[i];
        if (isSideEffectBarrier(inst)) {
          working.clear();
          continue;
        }
        const def = getDefinedOperandForReuse(inst);
        const defKey = def ? liveKey(def) : null;
        if (defKey) {
          for (const key of Array.from(working.keys())) {
            if (key.includes(`|${defKey}|`)) {
              working.delete(key);
            }
          }
        }
        const ek = exprKey(inst, keyForOperand);
        if (ek) {
          working.set(ek, { key: ek, inst });
        }
      }
      const currentOut = outMaps.get(block.id) ?? new Map();
      if (currentOut.size !== working.size) {
        outMaps.set(block.id, working);
        changed = true;
        continue;
      }
      for (const [key, value] of working.entries()) {
        const existing = currentOut.get(key);
        if (!existing || existing.key !== value.key) {
          outMaps.set(block.id, working);
          changed = true;
          break;
        }
      }
    }
  }

  return { inMaps, outMaps };
};

const insertBeforeTerminator = (
  block: { start: number; end: number },
  _instructions: TACInstruction[],
): number => {
  const last = _instructions[block.end];
  if (
    last.kind === TACInstructionKind.UnconditionalJump ||
    last.kind === TACInstructionKind.ConditionalJump ||
    last.kind === TACInstructionKind.Return
  ) {
    return block.end;
  }
  return block.end + 1;
};

const isTerminator = (inst: TACInstruction): boolean => {
  return (
    inst.kind === TACInstructionKind.UnconditionalJump ||
    inst.kind === TACInstructionKind.ConditionalJump ||
    inst.kind === TACInstructionKind.Return
  );
};

const usesOperandKey = (
  inst: TACInstruction,
  key: string,
  liveKey: (operand: TACOperand | undefined) => string | null,
): boolean => {
  return getUsedOperandsForReuse(inst).some((op) => liveKey(op) === key);
};

const definesOperandKey = (
  inst: TACInstruction,
  key: string,
  liveKey: (operand: TACOperand | undefined) => string | null,
): boolean => {
  const def = getDefinedOperandForReuse(inst);
  return !!def && liveKey(def) === key;
};

const isTempLocalToBlock = (
  block: { start: number; end: number },
  instructions: TACInstruction[],
  tempKey: string,
  liveKey: (operand: TACOperand | undefined) => string | null,
): boolean => {
  for (let i = 0; i < instructions.length; i += 1) {
    if (i >= block.start && i <= block.end) continue;
    if (usesOperandKey(instructions[i], tempKey, liveKey)) return false;
    if (definesOperandKey(instructions[i], tempKey, liveKey)) return false;
  }
  return true;
};

const isOperandAvailableInBlock = (
  block: { start: number; end: number },
  instructions: TACInstruction[],
  operand: TACOperand,
  liveKey: (operand: TACOperand | undefined) => string | null,
): boolean => {
  // Constants and labels always available
  if (operand.kind === TACOperandKind.Constant) return true;
  if (operand.kind === TACOperandKind.Label) return true;
  // Variables (locals/params) are assumed available at block entry
  if (operand.kind === TACOperandKind.Variable) return true;
  // Temporaries must be defined in the predecessor block to be available
  if (operand.kind === TACOperandKind.Temporary) {
    const key = liveKey(operand);
    if (!key) return false;
    for (let i = block.start; i <= block.end; i += 1) {
      const def = getDefinedOperandForReuse(instructions[i]);
      if (def && liveKey(def) === key) return true;
    }
    return false;
  }
  return false;
};

const findEquivalentExpr = (
  block: { start: number; end: number },
  instructions: TACInstruction[],
  targetExprKey: string,
  keyForOperand: (operand: TACOperand) => string,
): TACInstruction | null => {
  for (let i = block.start; i <= block.end; i += 1) {
    const inst = instructions[i];
    const ek = exprKey(inst, keyForOperand);
    if (ek === targetExprKey) return inst;
  }
  return null;
};

export const performPRE = (
  instructions: TACInstruction[],
  options?: { useSSA?: boolean },
): TACInstruction[] => {
  const useSSA = options?.useSSA === true;
  const keyForOperand = useSSA ? operandKeyWithSSA : operandKey;
  const liveKey = useSSA ? livenessKeyWithSSA : livenessKey;
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  const { inMaps } = computeAvailableMaps(instructions, options);
  const inserts = new Map<
    number,
    Array<{ order: number; insts: TACInstruction[] }>
  >();
  const removeIndices = new Set<number>();
  let nextTempId = getMaxTempId(instructions) + 1;

  for (const block of cfg.blocks) {
    const inMap = inMaps.get(block.id) ?? new Map();
    for (let i = block.start; i <= block.end; i += 1) {
      const inst = instructions[i];
      const ek = exprKey(inst, keyForOperand);
      if (!ek) continue;

      const dest = getExprDest(inst);
      if (!dest || dest.kind !== TACOperandKind.Temporary) continue;
      if (inMap.has(ek)) continue;
      if (block.preds.length < 2) continue;

      const destKey = liveKey(dest);
      if (!destKey) continue;
      let usedBefore = false;
      for (let j = block.start; j < i; j += 1) {
        if (usesOperandKey(instructions[j], destKey, liveKey)) {
          usedBefore = true;
          break;
        }
      }
      if (usedBefore) continue;
      if (!isTempLocalToBlock(block, instructions, destKey, liveKey)) continue;

      const exprOps = getExprOperands(inst);

      let canInsertAll = true;
      const predPlans: Array<{ index: number; insts: TACInstruction[] }> = [];
      for (const predId of block.preds) {
        const predBlock = cfg.blocks[predId];
        if (
          exprOps.some(
            (op) =>
              !isOperandAvailableInBlock(predBlock, instructions, op, liveKey),
          )
        ) {
          canInsertAll = false;
          break;
        }
        for (let j = predBlock.start; j <= predBlock.end; j += 1) {
          if (
            usesOperandKey(instructions[j], destKey, liveKey) ||
            definesOperandKey(instructions[j], destKey, liveKey)
          ) {
            canInsertAll = false;
            break;
          }
        }
        if (!canInsertAll) break;

        const insertIndex = insertBeforeTerminator(predBlock, instructions);
        if (insertIndex > predBlock.end) {
          canInsertAll = false;
          break;
        }
        const insts: TACInstruction[] = [];
        let existing = findEquivalentExpr(
          predBlock,
          instructions,
          ek,
          keyForOperand,
        );
        if (existing) {
          const existDest = getExprDest(existing);
          const existDestKey = existDest ? liveKey(existDest) : null;
          if (existDestKey) {
            let found = false;
            for (let j = predBlock.start; j <= predBlock.end; j += 1) {
              if (instructions[j] === existing) {
                found = true;
                continue;
              }
              if (
                found &&
                definesOperandKey(instructions[j], existDestKey, liveKey)
              ) {
                existing = null;
                break;
              }
            }
          }
        }
        if (existing) {
          const existDest = getExprDest(existing);
          if (existDest && keyForOperand(existDest) !== keyForOperand(dest)) {
            insts.push(new CopyInstruction(dest, existDest));
          }
        } else {
          const temp = createTemporary(nextTempId++, getOperandType(dest));
          insts.push(cloneExprWithDest(inst, temp));
          insts.push(new CopyInstruction(dest, temp));
        }

        if (insts.length > 0) {
          predPlans.push({ index: insertIndex, insts });
        }
      }
      if (!canInsertAll) continue;

      for (const plan of predPlans) {
        const list = inserts.get(plan.index) ?? [];
        list.push({ order: i, insts: plan.insts });
        inserts.set(plan.index, list);
      }

      removeIndices.add(i);
    }
  }

  if (inserts.size === 0 && removeIndices.size === 0) return instructions;

  const result: TACInstruction[] = [];
  for (let i = 0; i < instructions.length; i += 1) {
    const pending = inserts.get(i);
    const inst = instructions[i];
    if (pending) {
      const ordered = pending
        .slice()
        .sort((a, b) => a.order - b.order)
        .flatMap((entry) => entry.insts);
      if (isTerminator(inst)) {
        result.push(...ordered);
        if (!removeIndices.has(i)) result.push(inst);
      } else {
        if (!removeIndices.has(i)) result.push(inst);
        result.push(...ordered);
      }
      continue;
    }
    if (removeIndices.has(i)) continue;
    result.push(inst);
  }

  const tail = inserts.get(instructions.length);
  if (tail) {
    const ordered = tail
      .slice()
      .sort((a, b) => a.order - b.order)
      .flatMap((entry) => entry.insts);
    result.push(...ordered);
  }

  return result;
};

import {
  BinaryOpInstruction,
  CopyInstruction,
  type TACInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import {
  createTemporary,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import {
  getDefinedOperandForReuse,
  getMaxTempId,
  getUsedOperandsForReuse,
} from "../utils/instructions.js";
import { livenessKey } from "../utils/liveness.js";
import { operandKey } from "../utils/operands.js";
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

const binaryExprKey = (inst: BinaryOpInstruction): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  let leftKey = operandKey(inst.left);
  let rightKey = operandKey(inst.right);
  const commutative =
    inst.operator === "+" && typeKey === "String"
      ? false
      : isCommutativeOperator(inst.operator);
  if (commutative && leftKey > rightKey) {
    const tmp = leftKey;
    leftKey = rightKey;
    rightKey = tmp;
  }
  return `bin|${inst.operator}|${leftKey}|${rightKey}|${typeKey}|`;
};

type ExprValue = { key: string; inst: BinaryOpInstruction };

const computeAvailableMaps = (
  instructions: TACInstruction[],
): {
  inMaps: Map<number, Map<string, ExprValue>>;
  outMaps: Map<number, Map<string, ExprValue>>;
} => {
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
        const defKey = def ? livenessKey(def) : null;
        if (defKey) {
          for (const key of Array.from(working.keys())) {
            if (key.includes(`|${defKey}|`)) {
              working.delete(key);
            }
          }
        }
        if (inst.kind === TACInstructionKind.BinaryOp) {
          const bin = inst as BinaryOpInstruction;
          const exprKey = binaryExprKey(bin);
          working.set(exprKey, { key: exprKey, inst: bin });
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

const usesOperandKey = (inst: TACInstruction, key: string): boolean => {
  return getUsedOperandsForReuse(inst).some((op) => livenessKey(op) === key);
};

const definesOperandKey = (inst: TACInstruction, key: string): boolean => {
  const def = getDefinedOperandForReuse(inst);
  return !!def && livenessKey(def) === key;
};

const isTempLocalToBlock = (
  block: { start: number; end: number },
  instructions: TACInstruction[],
  tempKey: string,
): boolean => {
  for (let i = 0; i < instructions.length; i += 1) {
    if (i >= block.start && i <= block.end) continue;
    if (usesOperandKey(instructions[i], tempKey)) return false;
    if (definesOperandKey(instructions[i], tempKey)) return false;
  }
  return true;
};

const isOperandAvailableInBlock = (
  block: { start: number; end: number },
  instructions: TACInstruction[],
  operand: TACOperand,
): boolean => {
  // Constants and labels always available
  if (operand.kind === TACOperandKind.Constant) return true;
  if (operand.kind === TACOperandKind.Label) return true;
  // Variables (locals/params) are assumed available at block entry
  if (operand.kind === TACOperandKind.Variable) return true;
  // Temporaries must be defined in the predecessor block to be available
  if (operand.kind === TACOperandKind.Temporary) {
    const key = livenessKey(operand);
    if (!key) return false;
    for (let i = block.start; i <= block.end; i += 1) {
      const def = getDefinedOperandForReuse(instructions[i]);
      if (def && livenessKey(def) === key) return true;
    }
    return false;
  }
  return false;
};

const findEquivalentBinaryOp = (
  block: { start: number; end: number },
  instructions: TACInstruction[],
  exprKey: string,
): BinaryOpInstruction | null => {
  for (let i = block.start; i <= block.end; i += 1) {
    const inst = instructions[i];
    if (inst.kind !== TACInstructionKind.BinaryOp) continue;
    const bin = inst as BinaryOpInstruction;
    if (binaryExprKey(bin) === exprKey) return bin;
  }
  return null;
};

export const performPRE = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  const { inMaps } = computeAvailableMaps(instructions);
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
      if (inst.kind !== TACInstructionKind.BinaryOp) continue;
      const bin = inst as BinaryOpInstruction;
      if (bin.dest.kind !== TACOperandKind.Temporary) continue;
      const exprKey = binaryExprKey(bin);
      if (inMap.has(exprKey)) continue;
      if (block.preds.length < 2) continue;

      const destKey = livenessKey(bin.dest);
      if (!destKey) continue;
      let usedBefore = false;
      for (let j = block.start; j < i; j += 1) {
        if (usesOperandKey(instructions[j], destKey)) {
          usedBefore = true;
          break;
        }
      }
      if (usedBefore) continue;
      if (!isTempLocalToBlock(block, instructions, destKey)) continue;

      let canInsertAll = true;
      const predPlans: Array<{ index: number; insts: TACInstruction[] }> = [];
      for (const predId of block.preds) {
        const predBlock = cfg.blocks[predId];
        if (
          !isOperandAvailableInBlock(predBlock, instructions, bin.left) ||
          !isOperandAvailableInBlock(predBlock, instructions, bin.right)
        ) {
          canInsertAll = false;
          break;
        }
        for (let j = predBlock.start; j <= predBlock.end; j += 1) {
          if (
            usesOperandKey(instructions[j], destKey) ||
            definesOperandKey(instructions[j], destKey)
          ) {
            canInsertAll = false;
            break;
          }
        }
        if (!canInsertAll) break;

        const insertIndex = insertBeforeTerminator(predBlock, instructions);
        const insts: TACInstruction[] = [];
        const existing = findEquivalentBinaryOp(
          predBlock,
          instructions,
          exprKey,
        );
        if (existing) {
          if (operandKey(existing.dest) !== operandKey(bin.dest)) {
            insts.push(new CopyInstruction(bin.dest, existing.dest));
          }
        } else {
          const temp = createTemporary(nextTempId++, getOperandType(bin.dest));
          insts.push(
            new BinaryOpInstruction(temp, bin.left, bin.operator, bin.right),
          );
          insts.push(new CopyInstruction(bin.dest, temp));
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

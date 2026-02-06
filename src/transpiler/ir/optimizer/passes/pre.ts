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
  type TemporaryOperand,
} from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import {
  getDefinedOperandForReuse,
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
  return (
    op === "+" ||
    op === "*" ||
    op === "==" ||
    op === "!=" ||
    op === "&&" ||
    op === "||"
  );
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
      let hasSideEffect = false;
      for (let i = block.start; i <= block.end; i += 1) {
        const inst = instructions[i];
        if (isSideEffectBarrier(inst)) {
          hasSideEffect = true;
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
      if (hasSideEffect) {
        working.clear();
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
  return block.end;
};

const isTerminator = (inst: TACInstruction): boolean => {
  return (
    inst.kind === TACInstructionKind.UnconditionalJump ||
    inst.kind === TACInstructionKind.ConditionalJump ||
    inst.kind === TACInstructionKind.Return
  );
};

const getMaxTempId = (instructions: TACInstruction[]): number => {
  let maxTempId = -1;
  for (const inst of instructions) {
    const def = getDefinedOperandForReuse(inst);
    if (def?.kind === TACOperandKind.Temporary) {
      maxTempId = Math.max(maxTempId, (def as TemporaryOperand).id);
    }
    for (const op of getUsedOperandsForReuse(inst)) {
      if (op.kind === TACOperandKind.Temporary) {
        maxTempId = Math.max(maxTempId, (op as TemporaryOperand).id);
      }
    }
  }
  return maxTempId;
};

const usesOperandKey = (inst: TACInstruction, key: string): boolean => {
  return getUsedOperandsForReuse(inst).some((op) => livenessKey(op) === key);
};

const isOperandAvailableInBlock = (
  block: { start: number; end: number },
  instructions: TACInstruction[],
  operand: TACOperand,
): boolean => {
  if (operand.kind === TACOperandKind.Constant) return true;
  if (operand.kind === TACOperandKind.Label) return true;
  const key = livenessKey(operand);
  if (!key) return true;
  for (let i = block.start; i <= block.end; i += 1) {
    const def = getDefinedOperandForReuse(instructions[i]);
    if (def && livenessKey(def) === key) return true;
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
  const inserts = new Map<number, TACInstruction[]>();
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
          if (usesOperandKey(instructions[j], destKey)) {
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
        list.push(...plan.insts);
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
      if (isTerminator(inst)) {
        result.push(...pending);
        if (!removeIndices.has(i)) result.push(inst);
      } else {
        if (!removeIndices.has(i)) result.push(inst);
        result.push(...pending);
      }
      continue;
    }
    if (removeIndices.has(i)) continue;
    result.push(inst);
  }

  const tail = inserts.get(instructions.length);
  if (tail) result.push(...tail);

  return result;
};

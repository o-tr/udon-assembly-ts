import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  BinaryOpInstruction,
  type TACInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import type { VariableOperand } from "../../tac_operand.js";
import {
  type ConstantOperand,
  createConstant,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import {
  getDefinedOperandForReuse,
  getUsedOperandsForReuse,
} from "../utils/instructions.js";
import { livenessKey } from "../utils/liveness.js";
import {
  evaluateCastValue,
  getOperandType,
  isNumericUdonType,
} from "./constant_folding.js";
import { collectLoops, preheaderInsertIndex } from "./licm.js";

export const optimizeInductionVariables = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  const { loops, dom } = collectLoops(cfg);
  if (loops.length === 0) return instructions;
  const indexToBlock = new Map<number, number>();
  for (const block of cfg.blocks) {
    for (let i = block.start; i <= block.end; i++) {
      indexToBlock.set(i, block.id);
    }
  }

  const replacements = new Map<number, TACInstruction>();
  const inserts = new Map<number, TACInstruction[]>();
  const handled = new Set<string>();

  for (const loop of loops) {
    const loopBlocks = loop.blocks;
    const preheader = cfg.blocks[loop.preheaderId];
    const insertIndex = preheaderInsertIndex(preheader, instructions);

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
      const defOp = getDefinedOperandForReuse(instructions[index]);
      const defKey = livenessKey(defOp);
      if (defKey) {
        defCounts.set(defKey, (defCounts.get(defKey) ?? 0) + 1);
      }
    }

    const loopFirstUse = new Map<string, number>();
    for (const index of loopIndices) {
      const inst = instructions[index];
      for (const op of getUsedOperandsForReuse(inst)) {
        const key = livenessKey(op);
        if (key && !loopFirstUse.has(key)) {
          loopFirstUse.set(key, index);
        }
      }
    }

    const usedOutside = new Set<string>();
    for (let i = 0; i < instructions.length; i++) {
      if (loopIndexSet.has(i)) continue;
      for (const op of getUsedOperandsForReuse(instructions[i])) {
        const key = livenessKey(op);
        if (key) usedOutside.add(key);
      }
    }

    const updates = new Map<
      string,
      {
        index: number;
        delta: number;
        op: "+" | "-";
        operand: VariableOperand;
      }
    >();
    for (const index of loopIndices) {
      const inst = instructions[index];
      if (inst.kind !== TACInstructionKind.BinaryOp) continue;
      const bin = inst as BinaryOpInstruction;
      if (bin.operator !== "+" && bin.operator !== "-") continue;
      if (bin.dest.kind !== TACOperandKind.Variable) continue;
      if (bin.left.kind !== TACOperandKind.Variable) continue;
      if (
        (bin.dest as VariableOperand).name !==
        (bin.left as VariableOperand).name
      ) {
        continue;
      }
      if (bin.right.kind !== TACOperandKind.Constant) continue;
      const rightConst = bin.right as ConstantOperand;
      if (typeof rightConst.value !== "number") continue;
      if (!Number.isFinite(rightConst.value)) continue;
      const destType = getOperandType(bin.dest);
      if (!isNumericUdonType(destType.udonType)) continue;
      const key = livenessKey(bin.dest);
      if (!key) continue;
      if (updates.has(key)) continue;
      if ((defCounts.get(key) ?? 0) !== 1) continue;
      updates.set(key, {
        index,
        delta: rightConst.value,
        op: bin.operator as "+" | "-",
        operand: bin.dest as VariableOperand,
      });
    }

    for (const [varKey, update] of updates) {
      if (handled.has(varKey)) continue;

      let multiplyCandidate: {
        index: number;
        dest: TACOperand;
        factor: number;
        factorType: TypeSymbol;
        operator: "*";
      } | null = null;

      for (const index of loopIndices) {
        if (index <= update.index) continue;
        const inst = instructions[index];
        if (inst.kind !== TACInstructionKind.BinaryOp) continue;
        const bin = inst as BinaryOpInstruction;
        if (bin.operator !== "*") continue;
        const leftKey = livenessKey(bin.left);
        const rightKey = livenessKey(bin.right);
        const varIsLeft = leftKey === varKey;
        const varIsRight = rightKey === varKey;
        if (!varIsLeft && !varIsRight) continue;
        const other = varIsLeft ? bin.right : bin.left;
        if (other.kind !== TACOperandKind.Constant) continue;
        const constOp = other as ConstantOperand;
        if (typeof constOp.value !== "number") continue;
        if (!Number.isFinite(constOp.value)) continue;
        const destType = getOperandType(bin.dest);
        if (!isNumericUdonType(destType.udonType)) continue;
        const destKey = livenessKey(bin.dest);
        if (!destKey) continue;
        if ((defCounts.get(destKey) ?? 0) !== 1) continue;
        if (usedOutside.has(destKey)) continue;
        const firstUse = loopFirstUse.get(destKey);
        if (firstUse !== undefined && firstUse < index) continue;
        const updateBlockId = indexToBlock.get(update.index);
        const multiplyBlockId = indexToBlock.get(index);
        if (updateBlockId === undefined || multiplyBlockId === undefined) {
          continue;
        }
        if (
          updateBlockId !== multiplyBlockId &&
          !(dom.get(multiplyBlockId)?.has(updateBlockId) ?? false)
        ) {
          continue;
        }
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

      const destKey = livenessKey(multiplyCandidate.dest);
      if (!destKey) continue;
      if (handled.has(destKey)) continue;

      const delta = update.delta * multiplyCandidate.factor;
      if (!Number.isFinite(delta)) continue;

      const destType = getOperandType(multiplyCandidate.dest);
      const deltaValue = evaluateCastValue(delta, destType);
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
};

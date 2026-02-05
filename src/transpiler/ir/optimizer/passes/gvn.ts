import type { TACInstruction } from "../../tac_instruction.js";
import {
  BinaryOpInstruction,
  CastInstruction,
  CopyInstruction,
  TACInstructionKind,
  UnaryOpInstruction,
} from "../../tac_instruction.js";
import type { TACOperand } from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";
import type { TemporaryOperand, VariableOperand } from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import { getOperandType } from "./constant_folding.js";
import { operandKey, sameUdonType } from "../utils/operands.js";
import { getDefinedOperandForReuse } from "../utils/instructions.js";

type ExprValue = { operandKey: string; operand: TACOperand };

export const globalValueNumbering = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const cfg = buildCFG(instructions);
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
      const mergedIn = intersectExpressionMaps(predMaps);
      const currentIn = inMaps.get(block.id) ?? new Map();
      if (!exprMapsEqual(currentIn, mergedIn)) {
        inMaps.set(block.id, mergedIn);
        changed = true;
      }

      const simulated = simulateExpressionMap(
        mergedIn,
        instructions,
        block.start,
        block.end,
      );
      const currentOut = outMaps.get(block.id) ?? new Map();
      if (!exprMapsEqual(currentOut, simulated)) {
        outMaps.set(block.id, simulated);
        changed = true;
      }
    }
  }

  const result: TACInstruction[] = [];
  for (const block of cfg.blocks) {
    const working = new Map(inMaps.get(block.id) ?? new Map());
    for (let i = block.start; i <= block.end; i++) {
      let inst = instructions[i];
      const defined = getDefinedOperandForReuse(inst);
      const defKey = gvnOperandKey(defined);
      if (defKey) {
        killExpressionsUsingOperand(working, defKey);
      }

      if (inst.kind === TACInstructionKind.BinaryOp) {
        const bin = inst as BinaryOpInstruction;
        const exprKey = binaryExprKey(bin);
        const existing = working.get(exprKey);
        if (
          existing &&
          existing.operandKey !== operandKey(bin.dest) &&
          sameUdonType(existing.operand, bin.dest)
        ) {
          inst = new CopyInstruction(bin.dest, existing.operand);
        }
        result.push(inst);
        working.set(exprKey, {
          operandKey: operandKey(bin.dest),
          operand: bin.dest,
        });
        continue;
      }

      if (inst.kind === TACInstructionKind.UnaryOp) {
        const un = inst as UnaryOpInstruction;
        const exprKey = unaryExprKey(un);
        const existing = working.get(exprKey);
        if (
          existing &&
          existing.operandKey !== operandKey(un.dest) &&
          sameUdonType(existing.operand, un.dest)
        ) {
          inst = new CopyInstruction(un.dest, existing.operand);
        }
        result.push(inst);
        working.set(exprKey, {
          operandKey: operandKey(un.dest),
          operand: un.dest,
        });
        continue;
      }

      if (inst.kind === TACInstructionKind.Cast) {
        const castInst = inst as CastInstruction;
        const exprKey = castExprKey(castInst);
        const existing = working.get(exprKey);
        if (
          existing &&
          existing.operandKey !== operandKey(castInst.dest) &&
          sameUdonType(existing.operand, castInst.dest)
        ) {
          inst = new CopyInstruction(castInst.dest, existing.operand);
        }
        result.push(inst);
        working.set(exprKey, {
          operandKey: operandKey(castInst.dest),
          operand: castInst.dest,
        });
        continue;
      }

      result.push(inst);
    }
  }

  return result;
};

const intersectExpressionMaps = (
  predMaps: Array<Map<string, ExprValue>>,
): Map<string, ExprValue> => {
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
};

const exprMapsEqual = (
  a: Map<string, ExprValue>,
  b: Map<string, ExprValue>,
): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a.entries()) {
    const other = b.get(key);
    if (!other || other.operandKey !== value.operandKey) return false;
  }
  return true;
};

const simulateExpressionMap = (
  start: Map<string, ExprValue>,
  instructions: TACInstruction[],
  startIndex: number,
  endIndex: number,
): Map<string, ExprValue> => {
  const working = new Map(start);
  for (let i = startIndex; i <= endIndex; i++) {
    const inst = instructions[i];
    const defined = getDefinedOperandForReuse(inst);
    const defKey = gvnOperandKey(defined);
    if (defKey) {
      killExpressionsUsingOperand(working, defKey);
    }

    if (inst.kind === TACInstructionKind.BinaryOp) {
      const bin = inst as BinaryOpInstruction;
      const exprKey = binaryExprKey(bin);
      working.set(exprKey, {
        operandKey: operandKey(bin.dest),
        operand: bin.dest,
      });
    }

    if (inst.kind === TACInstructionKind.UnaryOp) {
      const un = inst as UnaryOpInstruction;
      const exprKey = unaryExprKey(un);
      working.set(exprKey, {
        operandKey: operandKey(un.dest),
        operand: un.dest,
      });
    }

    if (inst.kind === TACInstructionKind.Cast) {
      const castInst = inst as CastInstruction;
      const exprKey = castExprKey(castInst);
      working.set(exprKey, {
        operandKey: operandKey(castInst.dest),
        operand: castInst.dest,
      });
    }
  }
  return working;
};

const killExpressionsUsingOperand = (
  map: Map<string, ExprValue>,
  operandKeyValue: string,
): void => {
  const needle = `|${operandKeyValue}|`;
  for (const [key, value] of Array.from(map.entries())) {
    if (key.includes(needle) || value.operandKey === operandKeyValue) {
      map.delete(key);
    }
  }
};

const gvnOperandKey = (operand: TACOperand | undefined): string | null => {
  if (!operand) return null;
  if (operand.kind === TACOperandKind.Variable) {
    return `v:${(operand as VariableOperand).name}`;
  }
  if (operand.kind === TACOperandKind.Temporary) {
    return `t:${(operand as TemporaryOperand).id}`;
  }
  return null;
};

const isCommutativeOperator = (op: string): boolean => {
  return op === "+" || op === "*" || op === "==" || op === "!=" || op === "&&" || op === "||";
};

const binaryExprKey = (inst: BinaryOpInstruction): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  let leftKey = operandKey(inst.left);
  let rightKey = operandKey(inst.right);
  const commutative =
    inst.operator === "+" && typeKey === "String"
      ? false
      : isCommutativeOperator(inst.operator);
  if (commutative) {
    if (leftKey > rightKey) {
      const tmp = leftKey;
      leftKey = rightKey;
      rightKey = tmp;
    }
  }
  return `bin|${inst.operator}|${leftKey}|${rightKey}|${typeKey}|`;
};

const unaryExprKey = (inst: UnaryOpInstruction): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  const operandKeyValue = operandKey(inst.operand);
  return `un|${inst.operator}|${operandKeyValue}|${typeKey}|`;
};

const castExprKey = (inst: CastInstruction): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  const operandKeyValue = operandKey(inst.src);
  return `cast|${operandKeyValue}|${typeKey}|`;
};

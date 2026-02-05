import type { TACInstruction } from "../../tac_instruction.js";
import {
  type ArrayAccessInstruction,
  type BinaryOpInstruction,
  type CallInstruction,
  type CastInstruction,
  CopyInstruction,
  type PropertyGetInstruction,
  type PropertySetInstruction,
  TACInstructionKind,
  type UnaryOpInstruction,
} from "../../tac_instruction.js";
import type {
  TACOperand,
  TemporaryOperand,
  VariableOperand,
} from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import {
  getDefinedOperandForReuse,
  getUsedOperandsForReuse,
} from "../utils/instructions.js";
import { operandKey, sameUdonType } from "../utils/operands.js";
import { pureExternEvaluators } from "../utils/pure_extern.js";
import { getOperandType } from "./constant_folding.js";

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
      if (isSideEffectBarrier(inst)) {
        invalidateExpressionsForSideEffect(inst, working);
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

      if (inst.kind === TACInstructionKind.PropertyGet) {
        const getInst = inst as PropertyGetInstruction;
        const exprKey = propertyGetExprKey(getInst);
        const existing = working.get(exprKey);
        if (
          existing &&
          existing.operandKey !== operandKey(getInst.dest) &&
          sameUdonType(existing.operand, getInst.dest)
        ) {
          inst = new CopyInstruction(getInst.dest, existing.operand);
        }
        result.push(inst);
        working.set(exprKey, {
          operandKey: operandKey(getInst.dest),
          operand: getInst.dest,
        });
        continue;
      }

      if (inst.kind === TACInstructionKind.PropertySet) {
        const setInst = inst as PropertySetInstruction;
        result.push(inst);
        const valueType = getOperandType(setInst.value);
        const exprKey = `propget|${operandKey(setInst.object)}|${setInst.property}|${valueType.udonType}|`;
        working.set(exprKey, {
          operandKey: operandKey(setInst.value),
          operand: setInst.value,
        });
        continue;
      }

      if (inst.kind === TACInstructionKind.ArrayAccess) {
        const accInst = inst as ArrayAccessInstruction;
        const exprKey = arrayAccessExprKey(accInst);
        const existing = working.get(exprKey);
        if (
          existing &&
          existing.operandKey !== operandKey(accInst.dest) &&
          sameUdonType(existing.operand, accInst.dest)
        ) {
          inst = new CopyInstruction(accInst.dest, existing.operand);
        }
        result.push(inst);
        working.set(exprKey, {
          operandKey: operandKey(accInst.dest),
          operand: accInst.dest,
        });
        continue;
      }

      if (inst.kind === TACInstructionKind.Call) {
        const callInst = inst as CallInstruction;
        const exprKey = pureCallExprKey(callInst);
        if (exprKey && callInst.dest) {
          const existing = working.get(exprKey);
          if (
            existing &&
            existing.operandKey !== operandKey(callInst.dest) &&
            sameUdonType(existing.operand, callInst.dest)
          ) {
            const copy = new CopyInstruction(callInst.dest, existing.operand);
            result.push(copy);
            continue;
          }
          result.push(inst);
          working.set(exprKey, {
            operandKey: operandKey(callInst.dest),
            operand: callInst.dest,
          });
          continue;
        }
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
    if (isSideEffectBarrier(inst)) {
      invalidateExpressionsForSideEffect(inst, working);
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

    if (inst.kind === TACInstructionKind.PropertyGet) {
      const getInst = inst as PropertyGetInstruction;
      const exprKey = propertyGetExprKey(getInst);
      working.set(exprKey, {
        operandKey: operandKey(getInst.dest),
        operand: getInst.dest,
      });
    }

    if (inst.kind === TACInstructionKind.PropertySet) {
      const setInst = inst as PropertySetInstruction;
      const valueType = getOperandType(setInst.value);
      const exprKey = `propget|${operandKey(setInst.object)}|${setInst.property}|${valueType.udonType}|`;
      working.set(exprKey, {
        operandKey: operandKey(setInst.value),
        operand: setInst.value,
      });
    }

    if (inst.kind === TACInstructionKind.ArrayAccess) {
      const accInst = inst as ArrayAccessInstruction;
      const exprKey = arrayAccessExprKey(accInst);
      working.set(exprKey, {
        operandKey: operandKey(accInst.dest),
        operand: accInst.dest,
      });
    }

    if (inst.kind === TACInstructionKind.Call) {
      const callInst = inst as CallInstruction;
      const exprKey = pureCallExprKey(callInst);
      if (exprKey && callInst.dest) {
        working.set(exprKey, {
          operandKey: operandKey(callInst.dest),
          operand: callInst.dest,
        });
      }
    }
  }
  return working;
};

const isSideEffectBarrier = (inst: TACInstruction): boolean => {
  switch (inst.kind) {
    case TACInstructionKind.Call: {
      const callInst = inst as CallInstruction;
      return !pureExternEvaluators.has(callInst.func);
    }
    case TACInstructionKind.MethodCall:
    case TACInstructionKind.PropertySet:
    case TACInstructionKind.ArrayAssignment:
      return true;
    default:
      return false;
  }
};

const invalidateExpressionsForSideEffect = (
  inst: TACInstruction,
  map: Map<string, ExprValue>,
): void => {
  if (inst.kind === TACInstructionKind.Call) {
    for (const key of Array.from(map.keys())) {
      if (key.startsWith("propget|") || key.startsWith("arrayget|")) {
        map.delete(key);
      }
    }
  }
  if (inst.kind === TACInstructionKind.ArrayAssignment) {
    for (const key of Array.from(map.keys())) {
      if (key.startsWith("arrayget|")) {
        map.delete(key);
      }
    }
  }
  if (inst.kind === TACInstructionKind.PropertySet) {
    for (const key of Array.from(map.keys())) {
      if (key.startsWith("propget|")) {
        map.delete(key);
      }
    }
  }
  const usedOperands = getUsedOperandsForReuse(inst);
  for (const operand of usedOperands) {
    const key = gvnOperandKey(operand);
    if (!key) continue;
    killExpressionsUsingOperand(map, key);
  }
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

const propertyGetExprKey = (inst: PropertyGetInstruction): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  const objectKey = operandKey(inst.object);
  return `propget|${objectKey}|${inst.property}|${typeKey}|`;
};

const arrayAccessExprKey = (inst: ArrayAccessInstruction): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  const arrayKey = operandKey(inst.array);
  const indexKey = operandKey(inst.index);
  return `arrayget|${arrayKey}|${indexKey}|${typeKey}|`;
};

const pureCallExprKey = (inst: CallInstruction): string | null => {
  if (!inst.dest) return null;
  if (!pureExternEvaluators.has(inst.func)) return null;
  const typeKey = getOperandType(inst.dest).udonType;
  const argKeys = inst.args.map((arg) => operandKey(arg)).join("|");
  return `purecall|${inst.func}|${argKeys}|${typeKey}|`;
};

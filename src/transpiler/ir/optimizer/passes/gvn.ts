import { resolveExternSignature } from "../../../codegen/extern_signatures.js";
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
import { isIdempotentMethod } from "../utils/idempotent_methods.js";
import {
  getDefinedOperandForReuse,
  getUsedOperandsForReuse,
} from "../utils/instructions.js";
import {
  operandKey,
  operandKeyWithSSA,
  sameUdonType,
} from "../utils/operands.js";
import { pureExternEvaluators } from "../utils/pure_extern.js";
import { getOperandType } from "./constant_folding.js";

type ExprValue = { operandKey: string; operand: TACOperand };

export const globalValueNumbering = (
  instructions: TACInstruction[],
  options?: { useSSA?: boolean },
): TACInstruction[] => {
  const useSSA = options?.useSSA === true;
  const keyForOperand = useSSA ? operandKeyWithSSA : operandKey;
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
          keyForOperand,
          useSSA,
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
      const defKey = gvnOperandKey(defined, useSSA);
      if (defKey) {
        killExpressionsUsingOperand(working, defKey);
      }
      if (isSideEffectBarrier(inst)) {
        invalidateExpressionsForSideEffect(inst, working, useSSA);
      }

      if (inst.kind === TACInstructionKind.BinaryOp) {
        const bin = inst as BinaryOpInstruction;
        const exprKey = binaryExprKey(bin, keyForOperand);
        const existing = working.get(exprKey);
        if (
          existing &&
          existing.operandKey !== keyForOperand(bin.dest) &&
          sameUdonType(existing.operand, bin.dest)
        ) {
          inst = new CopyInstruction(bin.dest, existing.operand);
        }
        result.push(inst);
        working.set(exprKey, {
          operandKey: keyForOperand(bin.dest),
          operand: bin.dest,
        });
        continue;
      }

      if (inst.kind === TACInstructionKind.UnaryOp) {
        const un = inst as UnaryOpInstruction;
        const exprKey = unaryExprKey(un, keyForOperand);
        const existing = working.get(exprKey);
        if (
          existing &&
          existing.operandKey !== keyForOperand(un.dest) &&
          sameUdonType(existing.operand, un.dest)
        ) {
          inst = new CopyInstruction(un.dest, existing.operand);
        }
        result.push(inst);
        working.set(exprKey, {
          operandKey: keyForOperand(un.dest),
          operand: un.dest,
        });
        continue;
      }

      if (inst.kind === TACInstructionKind.Cast) {
        const castInst = inst as CastInstruction;
        const exprKey = castExprKey(castInst, keyForOperand);
        const existing = working.get(exprKey);
        if (
          existing &&
          existing.operandKey !== keyForOperand(castInst.dest) &&
          sameUdonType(existing.operand, castInst.dest)
        ) {
          inst = new CopyInstruction(castInst.dest, existing.operand);
        }
        result.push(inst);
        working.set(exprKey, {
          operandKey: keyForOperand(castInst.dest),
          operand: castInst.dest,
        });
        continue;
      }

      if (inst.kind === TACInstructionKind.PropertyGet) {
        const getInst = inst as PropertyGetInstruction;
        const exprKey = propertyGetExprKey(getInst, keyForOperand);
        const existing = working.get(exprKey);
        if (
          existing &&
          existing.operandKey !== keyForOperand(getInst.dest) &&
          sameUdonType(existing.operand, getInst.dest)
        ) {
          inst = new CopyInstruction(getInst.dest, existing.operand);
        }
        result.push(inst);
        working.set(exprKey, {
          operandKey: keyForOperand(getInst.dest),
          operand: getInst.dest,
        });
        continue;
      }

      if (inst.kind === TACInstructionKind.PropertySet) {
        const setInst = inst as PropertySetInstruction;
        result.push(inst);
        updatePropertySetCache(working, setInst, keyForOperand);
        continue;
      }

      if (inst.kind === TACInstructionKind.ArrayAccess) {
        const accInst = inst as ArrayAccessInstruction;
        const exprKey = arrayAccessExprKey(accInst, keyForOperand);
        const existing = working.get(exprKey);
        if (
          existing &&
          existing.operandKey !== keyForOperand(accInst.dest) &&
          sameUdonType(existing.operand, accInst.dest)
        ) {
          inst = new CopyInstruction(accInst.dest, existing.operand);
        }
        result.push(inst);
        working.set(exprKey, {
          operandKey: keyForOperand(accInst.dest),
          operand: accInst.dest,
        });
        continue;
      }

      if (inst.kind === TACInstructionKind.Call) {
        const callInst = inst as CallInstruction;
        const exprKey = callExprKey(callInst, keyForOperand);
        if (exprKey && callInst.dest) {
          const existing = working.get(exprKey);
          if (
            existing &&
            existing.operandKey !== keyForOperand(callInst.dest) &&
            sameUdonType(existing.operand, callInst.dest)
          ) {
            const copy = new CopyInstruction(callInst.dest, existing.operand);
            result.push(copy);
            continue;
          }
          result.push(inst);
          working.set(exprKey, {
            operandKey: keyForOperand(callInst.dest),
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
  keyForOperand: (operand: TACOperand) => string,
  useSSA: boolean,
): Map<string, ExprValue> => {
  const working = new Map(start);
  for (let i = startIndex; i <= endIndex; i++) {
    const inst = instructions[i];
    const defined = getDefinedOperandForReuse(inst);
    const defKey = gvnOperandKey(defined, useSSA);
    if (defKey) {
      killExpressionsUsingOperand(working, defKey);
    }
    if (isSideEffectBarrier(inst)) {
      invalidateExpressionsForSideEffect(inst, working, useSSA);
    }

    if (inst.kind === TACInstructionKind.BinaryOp) {
      const bin = inst as BinaryOpInstruction;
      const exprKey = binaryExprKey(bin, keyForOperand);
      working.set(exprKey, {
        operandKey: keyForOperand(bin.dest),
        operand: bin.dest,
      });
    }

    if (inst.kind === TACInstructionKind.UnaryOp) {
      const un = inst as UnaryOpInstruction;
      const exprKey = unaryExprKey(un, keyForOperand);
      working.set(exprKey, {
        operandKey: keyForOperand(un.dest),
        operand: un.dest,
      });
    }

    if (inst.kind === TACInstructionKind.Cast) {
      const castInst = inst as CastInstruction;
      const exprKey = castExprKey(castInst, keyForOperand);
      working.set(exprKey, {
        operandKey: keyForOperand(castInst.dest),
        operand: castInst.dest,
      });
    }

    if (inst.kind === TACInstructionKind.PropertyGet) {
      const getInst = inst as PropertyGetInstruction;
      const exprKey = propertyGetExprKey(getInst, keyForOperand);
      working.set(exprKey, {
        operandKey: keyForOperand(getInst.dest),
        operand: getInst.dest,
      });
    }

    if (inst.kind === TACInstructionKind.PropertySet) {
      const setInst = inst as PropertySetInstruction;
      updatePropertySetCache(working, setInst, keyForOperand);
    }

    if (inst.kind === TACInstructionKind.ArrayAccess) {
      const accInst = inst as ArrayAccessInstruction;
      const exprKey = arrayAccessExprKey(accInst, keyForOperand);
      working.set(exprKey, {
        operandKey: keyForOperand(accInst.dest),
        operand: accInst.dest,
      });
    }

    if (inst.kind === TACInstructionKind.Call) {
      const callInst = inst as CallInstruction;
      const exprKey = callExprKey(callInst, keyForOperand);
      if (exprKey && callInst.dest) {
        working.set(exprKey, {
          operandKey: keyForOperand(callInst.dest),
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
      return (
        !pureExternEvaluators.has(callInst.func) &&
        !isIdempotentMethod(callInst.func)
      );
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
  useSSA: boolean,
): void => {
  if (inst.kind === TACInstructionKind.Call) {
    for (const key of Array.from(map.keys())) {
      if (key.startsWith("propget_idem|")) continue; // idempotent properties are always safe
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
      if (key.startsWith("propget|") || key.startsWith("propget_idem|")) {
        map.delete(key);
      }
    }
  }
  const usedOperands = getUsedOperandsForReuse(inst);
  for (const operand of usedOperands) {
    const key = gvnOperandKey(operand, useSSA);
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

const gvnOperandKey = (
  operand: TACOperand | undefined,
  useSSA: boolean,
): string | null => {
  if (!operand) return null;
  const ssaVersion = (operand as { ssaVersion?: number }).ssaVersion;
  if (operand.kind === TACOperandKind.Variable) {
    if (useSSA) {
      return `v:${(operand as VariableOperand).name}:${ssaVersion ?? ""}`;
    }
    return `v:${(operand as VariableOperand).name}`;
  }
  if (operand.kind === TACOperandKind.Temporary) {
    if (useSSA) {
      return `t:${(operand as TemporaryOperand).id}:${ssaVersion ?? ""}`;
    }
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

const binaryExprKey = (
  inst: BinaryOpInstruction,
  keyForOperand: (operand: TACOperand) => string,
): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  let leftKey = keyForOperand(inst.left);
  let rightKey = keyForOperand(inst.right);
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

const unaryExprKey = (
  inst: UnaryOpInstruction,
  keyForOperand: (operand: TACOperand) => string,
): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  const operandKeyValue = keyForOperand(inst.operand);
  return `un|${inst.operator}|${operandKeyValue}|${typeKey}|`;
};

const castExprKey = (
  inst: CastInstruction,
  keyForOperand: (operand: TACOperand) => string,
): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  const operandKeyValue = keyForOperand(inst.src);
  return `cast|${operandKeyValue}|${typeKey}|`;
};

const propertyGetExprKey = (
  inst: PropertyGetInstruction,
  keyForOperand: (operand: TACOperand) => string,
): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  const objectKey = keyForOperand(inst.object);
  const objectTypeName = getOperandType(inst.object).name;
  const returnTypeName = getOperandType(inst.dest).name;
  const signature = resolveExternSignature(
    objectTypeName,
    inst.property,
    "getter",
    [],
    returnTypeName,
  );
  const prefix =
    signature && isIdempotentMethod(signature) ? "propget_idem" : "propget";
  return `${prefix}|${objectKey}|${inst.property}|${typeKey}|`;
};

const propertySetExprKey = (
  inst: PropertySetInstruction,
  keyForOperand: (operand: TACOperand) => string,
): string => {
  const valueType = getOperandType(inst.value);
  const typeKey = valueType.udonType;
  const objectKey = keyForOperand(inst.object);
  const objectTypeName = getOperandType(inst.object).name;
  const signature = resolveExternSignature(
    objectTypeName,
    inst.property,
    "getter",
    [],
    valueType.name,
  );
  const prefix =
    signature && isIdempotentMethod(signature) ? "propget_idem" : "propget";
  return `${prefix}|${objectKey}|${inst.property}|${typeKey}|`;
};

const updatePropertySetCache = (
  map: Map<string, ExprValue>,
  inst: PropertySetInstruction,
  keyForOperand: (operand: TACOperand) => string,
): void => {
  const objectKey = keyForOperand(inst.object);
  let updated = false;
  for (const key of Array.from(map.keys())) {
    if (!key.startsWith("propget|") && !key.startsWith("propget_idem|")) {
      continue;
    }
    if (!key.includes(`|${objectKey}|${inst.property}|`)) {
      continue;
    }
    map.set(key, {
      operandKey: keyForOperand(inst.value),
      operand: inst.value,
    });
    updated = true;
  }

  if (!updated) {
    const exprKey = propertySetExprKey(inst, keyForOperand);
    map.set(exprKey, {
      operandKey: keyForOperand(inst.value),
      operand: inst.value,
    });
  }
};

const arrayAccessExprKey = (
  inst: ArrayAccessInstruction,
  keyForOperand: (operand: TACOperand) => string,
): string => {
  const typeKey = getOperandType(inst.dest).udonType;
  const arrayKey = keyForOperand(inst.array);
  const indexKey = keyForOperand(inst.index);
  return `arrayget|${arrayKey}|${indexKey}|${typeKey}|`;
};

const callExprKey = (
  inst: CallInstruction,
  keyForOperand: (operand: TACOperand) => string,
): string | null => {
  if (!inst.dest) return null;
  const isPure = pureExternEvaluators.has(inst.func);
  const isIdempotent = isIdempotentMethod(inst.func);
  if (!isPure && !isIdempotent) return null;
  const typeKey = getOperandType(inst.dest).udonType;
  const argKeys = inst.args.map((arg) => keyForOperand(arg)).join("|");
  const prefix = isPure ? "purecall" : "idempotentcall";
  return `${prefix}|${inst.func}|${argKeys}|${typeKey}|`;
};

import type {
  ConstantOperand,
  TACOperand,
  TemporaryOperand,
  VariableOperand,
} from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";

export const sameOperand = (a: TACOperand, b: TACOperand): boolean => {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case TACOperandKind.Variable:
      return (a as VariableOperand).name === (b as VariableOperand).name;
    case TACOperandKind.Temporary:
      return (a as TemporaryOperand).id === (b as TemporaryOperand).id;
    default:
      return false;
  }
};

export const sameUdonType = (a: TACOperand, b: TACOperand): boolean => {
  const aType = (a as { type?: { udonType?: string } }).type?.udonType ?? null;
  const bType = (b as { type?: { udonType?: string } }).type?.udonType ?? null;
  if (!aType || !bType) return false;
  return aType === bType;
};

export const stringifyConstant = (value: unknown): string => {
  return JSON.stringify(value, (_key, val) =>
    typeof val === "bigint" ? { __bigint__: val.toString() } : val,
  );
};

export const operandKey = (operand: TACOperand): string => {
  if (operand.kind === TACOperandKind.Variable) {
    return `v:${(operand as unknown as { name: string }).name}`;
  }
  if (operand.kind === TACOperandKind.Constant) {
    return `c:${stringifyConstant((operand as ConstantOperand).value)}`;
  }
  if (operand.kind === TACOperandKind.Temporary) {
    return `t:${(operand as unknown as { id: number }).id}`;
  }
  return "other";
};

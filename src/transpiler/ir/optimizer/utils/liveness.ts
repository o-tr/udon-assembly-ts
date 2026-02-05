import type { TACOperand } from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";
import type { TemporaryOperand, VariableOperand } from "../../tac_operand.js";

export const livenessKey = (operand: TACOperand | undefined): string | null => {
  if (!operand) return null;
  if (operand.kind === TACOperandKind.Variable) {
    const variable = operand as VariableOperand;
    return `v:${variable.name}`;
  }
  if (operand.kind === TACOperandKind.Temporary) {
    const temp = operand as TemporaryOperand;
    return `t:${temp.id}`;
  }
  return null;
};

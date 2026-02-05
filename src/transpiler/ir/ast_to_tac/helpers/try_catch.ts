import { ObjectType, PrimitiveTypes } from "../../../frontend/type_symbols.js";
import { UdonType } from "../../../frontend/types.js";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import { createConstant, type TACOperand, type VariableOperand } from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

export function emitTryInstructionsWithChecks(
  this: ASTToTACConverter,
  instructions: TACInstruction[],
  errorFlag: VariableOperand,
  errorValue: VariableOperand,
  errorTarget: TACOperand,
): void {
  for (const inst of instructions) {
    this.instructions.push(inst);

    const checkOperand = this.getCheckOperand(inst);
    if (!checkOperand) continue;
    const checkType = this.getOperandType(checkOperand);
    if (!this.isNullableType(checkType)) continue;

    const isNullTemp = this.newTemp(PrimitiveTypes.boolean);
    this.instructions.push(
      new BinaryOpInstruction(
        isNullTemp,
        checkOperand,
        "==",
        createConstant(null, ObjectType),
      ),
    );
    const continueLabel = this.newLabel("try_continue");
    this.instructions.push(
      new ConditionalJumpInstruction(isNullTemp, continueLabel),
    );
    this.instructions.push(
      new AssignmentInstruction(
        errorFlag,
        createConstant(true, PrimitiveTypes.boolean),
      ),
    );
    this.instructions.push(new CopyInstruction(errorValue, checkOperand));
    this.instructions.push(new UnconditionalJumpInstruction(errorTarget));
    this.instructions.push(new LabelInstruction(continueLabel));
  }
}

export function getCheckOperand(
  this: ASTToTACConverter,
  inst: TACInstruction
): TACOperand | null {
  switch (inst.kind) {
    case TACInstructionKind.Call:
      return (inst as CallInstruction).dest ?? null;
    case TACInstructionKind.MethodCall:
      return (inst as MethodCallInstruction).dest ?? null;
    case TACInstructionKind.PropertyGet:
      return (inst as PropertyGetInstruction).dest ?? null;
    default:
      return null;
  }
}

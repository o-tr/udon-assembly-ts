import { ObjectType, PrimitiveTypes } from "../../../frontend/type_symbols.js";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  type CallInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  type MethodCallInstruction,
  type PropertyGetInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  createConstant,
  type TACOperand,
  type VariableOperand,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

export function emitTryInstructionsWithChecks(
  this: ASTToTACConverter,
  instructions: TACInstruction[],
  errorFlag: VariableOperand,
  errorValue: VariableOperand,
  errorTarget: TACOperand,
): void {
  for (const inst of instructions) {
    this.emit(inst);

    const checkOperand = this.getCheckOperand(inst);
    if (!checkOperand) continue;
    const checkType = this.getOperandType(checkOperand);
    if (!this.isNullableType(checkType)) continue;

    // Box the typed `checkOperand` into Object before the null compare.
    // For typed-slot operands (DataList / Array / interface), comparing
    // directly against the null-Object constant lowers to a mismatched-
    // operand-types op_Equality and may not detect a null reference reliably.
    // Same boxing pattern as visitNullCoalescingExpression and the SoA
    // emitBoundedDataListGetItem fix.
    const boxedOperand = this.newTemp(ObjectType);
    this.emit(new CopyInstruction(boxedOperand, checkOperand));
    const isNullTemp = this.newTemp(PrimitiveTypes.boolean);
    this.emit(
      new BinaryOpInstruction(
        isNullTemp,
        boxedOperand,
        "==",
        createConstant(null, ObjectType),
      ),
    );
    const continueLabel = this.newLabel("try_continue");
    this.emit(new ConditionalJumpInstruction(isNullTemp, continueLabel));
    this.emit(
      new AssignmentInstruction(
        errorFlag,
        createConstant(true, PrimitiveTypes.boolean),
      ),
    );
    // Plain copy: the error slot is a null sentinel path, not an inline
    // instance — tracking would incorrectly pollute inlineInstanceMap.
    this.emit(new CopyInstruction(errorValue, checkOperand));
    this.emit(new UnconditionalJumpInstruction(errorTarget));
    this.emit(new LabelInstruction(continueLabel));
  }
}

export function getCheckOperand(
  this: ASTToTACConverter,
  inst: TACInstruction,
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

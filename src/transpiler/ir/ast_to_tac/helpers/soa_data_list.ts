import { PrimitiveTypes } from "../../../frontend/type_symbols.js";
import {
  BinaryOpInstruction,
  ConditionalJumpInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import { createConstant, type TACOperand } from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

/**
 * Emit `DataList.get_Item` with a bounds-guard TAC shape that matches
 * `detectIndexAwareGuardBeforeGetItem` in regression tests:
 * `Count` → `index < Count` → `ifFalse` → in-bounds `get_Item(index)`;
 * OOB falls through to a second `Count` / `0 < Count` / `ifFalse` block
 * before `get_Item(0)` (sentinel row after SoA init).
 */
export function emitBoundedDataListGetItem(
  converter: ASTToTACConverter,
  listVar: TACOperand,
  indexVar: TACOperand,
  destToken: TACOperand,
): void {
  const countTemp = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new PropertyGetInstruction(countTemp, listVar, "Count"),
  );
  const okTemp = converter.newTemp(PrimitiveTypes.boolean);
  converter.instructions.push(
    new BinaryOpInstruction(okTemp, indexVar, "<", countTemp),
  );
  const oobLabel = converter.newLabel("soa_get_oob");
  const mergeLabel = converter.newLabel("soa_get_merge");
  converter.instructions.push(new ConditionalJumpInstruction(okTemp, oobLabel));
  converter.instructions.push(
    new MethodCallInstruction(destToken, listVar, "get_Item", [indexVar]),
  );
  converter.instructions.push(new UnconditionalJumpInstruction(mergeLabel));
  converter.instructions.push(new LabelInstruction(oobLabel));
  const count2 = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new PropertyGetInstruction(count2, listVar, "Count"),
  );
  const ok2 = converter.newTemp(PrimitiveTypes.boolean);
  const zero = createConstant(0, PrimitiveTypes.int32);
  converter.instructions.push(new BinaryOpInstruction(ok2, zero, "<", count2));
  converter.instructions.push(new ConditionalJumpInstruction(ok2, mergeLabel));
  converter.instructions.push(
    new MethodCallInstruction(destToken, listVar, "get_Item", [zero]),
  );
  converter.instructions.push(new LabelInstruction(mergeLabel));
}

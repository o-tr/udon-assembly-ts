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
import { normalizeOperandToInt32 } from "./int32_normalization.js";

/**
 * Emit `DataList.get_Item` with a bounds-guard TAC shape that matches
 * `detectIndexAwareGuardBeforeGetItem` in regression tests:
 * `Count` → `index < Count` → `ifFalse` → in-bounds `get_Item(index)`;
 * OOB path: `0 < countTemp` → `ifFalse` → `get_Item(0)` using the sentinel row
 * (SoA init always `Add`s index 0, so `Count >= 1` before any SoA field read).
 *
 * If `Count == 0`, `ifFalse ok2 goto merge` skips `get_Item(0)` and `destToken` is
 * never written — unreachable for SoA field lists after `emitSoaInitGuard`, which
 * reserves index 0 and leaves `Count >= 1`.
 */
export function emitBoundedDataListGetItem(
  converter: ASTToTACConverter,
  listVar: TACOperand,
  indexVar: TACOperand,
  destToken: TACOperand,
): void {
  const intIndexVar = normalizeOperandToInt32(converter, indexVar);
  const countTemp = converter.newTemp(PrimitiveTypes.int32);
  converter.emit(new PropertyGetInstruction(countTemp, listVar, "Count"));
  const okTemp = converter.newTemp(PrimitiveTypes.boolean);
  converter.emit(new BinaryOpInstruction(okTemp, intIndexVar, "<", countTemp));
  const oobLabel = converter.newLabel("soa_get_oob");
  const mergeLabel = converter.newLabel("soa_get_merge");
  converter.emit(new ConditionalJumpInstruction(okTemp, oobLabel));
  converter.emit(
    new MethodCallInstruction(destToken, listVar, "get_Item", [intIndexVar]),
  );
  converter.emit(new UnconditionalJumpInstruction(mergeLabel));
  converter.emit(new LabelInstruction(oobLabel));
  const ok2 = converter.newTemp(PrimitiveTypes.boolean);
  const zero = createConstant(0, PrimitiveTypes.int32);
  converter.emit(new BinaryOpInstruction(ok2, zero, "<", countTemp));
  converter.emit(new ConditionalJumpInstruction(ok2, mergeLabel));
  converter.emit(
    new MethodCallInstruction(destToken, listVar, "get_Item", [zero]),
  );
  converter.emit(new LabelInstruction(mergeLabel));
}

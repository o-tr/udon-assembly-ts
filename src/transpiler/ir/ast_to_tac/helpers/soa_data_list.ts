import { ObjectType, PrimitiveTypes } from "../../../frontend/type_symbols.js";
import {
  BinaryOpInstruction,
  CallInstruction,
  ConditionalJumpInstruction,
  CopyInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  createConstant,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";
import { normalizeOperandToInt32 } from "./int32_normalization.js";

/**
 * Emit `DataList.get_Item` with a bounds-guard TAC shape that matches
 * `detectIndexAwareGuardBeforeGetItem` in regression tests:
 * `Count` → `index < Count` → `ifFalse` → in-bounds `get_Item(index)`;
 * OOB path: `0 < countTemp` → `ifFalse` → `get_Item(0)` using the sentinel row
 * (SoA init always `Add`s index 0, so `Count >= 1` before any SoA field read).
 *
 * `guardListNotNull` enables a runtime null-and-seed check before the
 * Count/get_Item externs. Required when the caller may probe a candidate
 * SoA class before its constructor has run (D3 dispatch and untracked-handle
 * SoA method dispatch). Skip on direct property reads via tryReadSoAField,
 * where the field list is guaranteed non-null because we already hold a
 * concrete instance prefix — the guard would emit ~7 dead instructions
 * (box / null-compare / branch / ctor / sentinel Add / label) per access.
 */
export function emitBoundedDataListGetItem(
  converter: ASTToTACConverter,
  listVar: TACOperand,
  indexVar: TACOperand,
  destToken: TACOperand,
  sentinelValue: TACOperand = createConstant(null, ObjectType),
  guardListNotNull = false,
): void {
  if (guardListNotNull) {
    if (listVar.kind !== TACOperandKind.Variable) {
      throw new Error(
        "emitBoundedDataListGetItem: guardListNotNull requires a Variable operand, " +
          `got ${TACOperandKind[listVar.kind]}`,
      );
    }
    // Note: this guard does NOT touch `__soa_${className}__inited`.
    // That flag is owned by the companion `emitSoaInitGuard`
    // (helpers/inline.ts).  Because this guard does not set the flag,
    // `emitSoaInitGuard` will see the slot as uninitialized and run the
    // real constructor on first entry, overwriting the placeholder DataList
    // and sentinel row created below.
    //
    // INVARIANT: `emitSoaInitGuard` must remain "inited-flag-only" and must
    // NOT add a null-aware skip (e.g. "skip ctor when listVar is non-null").
    // If it ever does, the seeded list emitted here would survive past first
    // real construction, causing the sentinel row at index 0 to coexist with
    // real instance rows and corrupt all subsequent SoA field reads. Any
    // future optimisation to skip construction must either (a) set the
    // `__soa_${className}__inited` flag from this guard, or (b) explicitly
    // overwrite / clear the pre-existing DataList before skipping.
    const boxedList = converter.newTemp(ObjectType);
    converter.emit(new CopyInstruction(boxedList, listVar));
    const listIsNull = converter.newTemp(PrimitiveTypes.boolean);
    const listReady = converter.newLabel("soa_list_ready");
    converter.emit(
      new BinaryOpInstruction(
        listIsNull,
        boxedList,
        "==",
        createConstant(null, ObjectType),
      ),
    );
    converter.emit(new ConditionalJumpInstruction(listIsNull, listReady));
    const listCtorSig = converter.requireExternSignature(
      "DataList",
      "ctor",
      "method",
      [],
      "DataList",
    );
    converter.emit(new CallInstruction(listVar, listCtorSig, []));
    // listVar now holds the freshly-constructed DataList.
    // wrapDataToken is safe here because it only reads sentinelValue, not listVar.
    const nullToken = converter.wrapDataToken(sentinelValue);
    converter.emit(
      new MethodCallInstruction(undefined, listVar, "Add", [nullToken]),
    );
    converter.emit(new LabelInstruction(listReady));
  }

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

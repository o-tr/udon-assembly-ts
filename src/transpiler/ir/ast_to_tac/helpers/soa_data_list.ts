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
  createVariable,
  type TACOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";
import { normalizeOperandToInt32 } from "./int32_normalization.js";

function sanitizeSoAIdentifierToken(raw: string): string {
  const replaced = raw.replace(/[^A-Za-z0-9_]/g, "_");
  const normalized =
    replaced.length === 0
      ? "_anon"
      : /^[A-Za-z_]/.test(replaced)
        ? replaced
        : `_${replaced}`;
  if (normalized === raw) return normalized;
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${normalized}__h${hash.toString(16)}`;
}

/**
 * Number of handle slots reserved per SoA class.
 * Class i occupies handles [i*SOA_PARTITION_SIZE+1 .. (i+1)*SOA_PARTITION_SIZE-1].
 * 1<<20 = 1,048,576 — supports ~2000 SoA classes within Int32 range.
 */
export const SOA_PARTITION_SIZE = 1 << 20;

/**
 * Convert a runtime SoA handle to the DataList index for the given class.
 * Each class has a compile-time offset so that handles from different classes
 * never collide (class 0 offset=0, class 1 offset=SOA_PARTITION_SIZE, …).
 * DataList indices are always sequential from 1, so index = handle − offset.
 *
 * When offset is 0 (class 0, or unknown class), returns hdlVar unchanged so
 * no extra instruction is emitted.
 */
export function emitSoaHandleToIndex(
  converter: ASTToTACConverter,
  hdlVar: TACOperand,
  className: string,
): TACOperand {
  const offset = converter.soaClassOffsets.get(className) ?? 0;
  if (offset === 0) return hdlVar;
  const indexVar = converter.newTemp(PrimitiveTypes.int32);
  converter.emit(
    new BinaryOpInstruction(
      indexVar,
      hdlVar,
      "-",
      createConstant(offset, PrimitiveTypes.int32),
    ),
  );
  return indexVar;
}

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
 * SoA method dispatch). Also use it on direct property reads via
 * `tryReadSoAField`, which can still see `-1` sentinel handles from erased
 * dispatch and needs the lower-bound guard even though the field list itself
 * is non-null.
 */
export function emitBoundedDataListGetItem(
  converter: ASTToTACConverter,
  listVar: TACOperand,
  indexVar: TACOperand,
  destToken: TACOperand,
  sentinelValue: TACOperand | (() => TACOperand) = () =>
    createConstant(null, ObjectType),
  guardListNotNull = false,
  guardClassName?: string,
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
    const resolvedSentinelValue =
      typeof sentinelValue === "function" ? sentinelValue() : sentinelValue;
    const listReady = converter.newLabel("soa_list_ready");
    if (guardClassName) {
      const initedVar = createVariable(
        `__soa_${sanitizeSoAIdentifierToken(guardClassName)}__inited`,
        PrimitiveTypes.int32,
      );
      const alreadyInited = converter.newTemp(PrimitiveTypes.boolean);
      const seedList = converter.newLabel("soa_seed_list");
      converter.emit(
        new BinaryOpInstruction(
          alreadyInited,
          initedVar,
          "==",
          createConstant(1, PrimitiveTypes.int32),
        ),
      );
      converter.emit(new ConditionalJumpInstruction(alreadyInited, seedList));
      converter.emit(new UnconditionalJumpInstruction(listReady));
      converter.emit(new LabelInstruction(seedList));
    } else {
      const boxedList = converter.newTemp(ObjectType);
      converter.emit(new CopyInstruction(boxedList, listVar));
      const listIsNull = converter.newTemp(PrimitiveTypes.boolean);
      converter.emit(
        new BinaryOpInstruction(
          listIsNull,
          boxedList,
          "==",
          createConstant(null, ObjectType),
        ),
      );
      converter.emit(new ConditionalJumpInstruction(listIsNull, listReady));
    }
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
    const nullToken = converter.wrapDataToken(resolvedSentinelValue);
    converter.emit(
      new MethodCallInstruction(undefined, listVar, "Add", [nullToken]),
    );
    converter.emit(new LabelInstruction(listReady));
  }

  const intIndexVar = normalizeOperandToInt32(converter, indexVar);
  const countTemp = converter.newTemp(PrimitiveTypes.int32);
  converter.emit(new PropertyGetInstruction(countTemp, listVar, "Count"));
  const oobLabel = converter.newLabel("soa_get_oob");
  const mergeLabel = converter.newLabel("soa_get_merge");

  if (guardListNotNull) {
    // Lower-bound guard: negative handles (null sentinel = -1) must not reach
    // get_Item, which throws ArgumentOutOfRangeException for negative indices.
    const okLower = converter.newTemp(PrimitiveTypes.boolean);
    converter.emit(
      new BinaryOpInstruction(
        okLower,
        intIndexVar,
        ">=",
        createConstant(0, PrimitiveTypes.int32),
      ),
    );
    converter.emit(new ConditionalJumpInstruction(okLower, oobLabel));
  }

  // Upper-bound guard
  const okUpper = converter.newTemp(PrimitiveTypes.boolean);
  converter.emit(new BinaryOpInstruction(okUpper, intIndexVar, "<", countTemp));
  converter.emit(new ConditionalJumpInstruction(okUpper, oobLabel));

  // In-bounds path
  converter.emit(
    new MethodCallInstruction(destToken, listVar, "get_Item", [intIndexVar]),
  );
  converter.emit(new UnconditionalJumpInstruction(mergeLabel));

  // OOB fallback: sentinel row at index 0 (valid because Count >= 1 after init)
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

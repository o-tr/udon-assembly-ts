import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  CollectionTypeSymbol,
  DataListTypeSymbol,
  ExternTypes,
  PrimitiveTypes,
} from "../../../frontend/type_symbols.js";
import { UdonType } from "../../../frontend/types.js";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  ConditionalJumpInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import { createConstant, type TACOperand } from "../../tac_operand.js";
import type { ASTToTACConverter } from "../converter.js";

export const isSetCollectionType = (
  type: TypeSymbol | null,
): type is CollectionTypeSymbol =>
  type instanceof CollectionTypeSymbol &&
  type.name === ExternTypes.dataDictionary.name &&
  type.elementType !== undefined;

// Note: unlike isSetCollectionType, this returns `boolean` (not a type guard)
// because it also matches ExternTypeSymbol and other non-CollectionTypeSymbol
// types that represent DataDictionary. Callers should not rely on type
// narrowing from this check.
export const isMapCollectionType = (type: TypeSymbol | null): boolean => {
  if (!type) return false;
  // CollectionTypeSymbol with DataDictionary name and no elementType → map
  if (type instanceof CollectionTypeSymbol) {
    return (
      type.name === ExternTypes.dataDictionary.name &&
      type.elementType === undefined
    );
  }
  // ExternTypeSymbol or other type with DataDictionary UdonType → map
  return type.udonType === UdonType.DataDictionary;
};

/**
 * Emits a GetKeys call on a DataDictionary and returns the resulting DataList operand.
 */
export const emitMapKeysList = (
  converter: ASTToTACConverter,
  mapOperand: TACOperand,
  keyType: TypeSymbol,
): TACOperand => {
  const keysList = converter.newTemp(new DataListTypeSymbol(keyType));
  converter.instructions.push(
    new MethodCallInstruction(keysList, mapOperand, "GetKeys", []),
  );
  return keysList;
};

/**
 * Emits TAC instructions that build a DataList of [key, value] pair lists
 * from a DataDictionary, suitable for for-of destructuring iteration.
 *
 * @param keyType - Type of the keys list elements (default: ExternTypes.dataToken)
 */
export const emitMapEntriesList = (
  converter: ASTToTACConverter,
  mapOperand: TACOperand,
  keyType: TypeSymbol = ExternTypes.dataToken,
): TACOperand => {
  const keysList = emitMapKeysList(converter, mapOperand, keyType);

  // The entries list always holds DataToken-wrapped pair lists, regardless of
  // keyType. The keyType parameter only affects the GetKeys call above.
  const entriesType = new DataListTypeSymbol(ExternTypes.dataToken);
  const entriesResult = converter.newTemp(entriesType);
  const listCtorSig = converter.requireExternSignature(
    "DataList",
    "ctor",
    "method",
    [],
    "DataList",
  );
  converter.instructions.push(
    new CallInstruction(entriesResult, listCtorSig, []),
  );

  const indexVar = converter.newTemp(PrimitiveTypes.int32);
  const lengthVar = converter.newTemp(PrimitiveTypes.int32);
  converter.instructions.push(
    new AssignmentInstruction(
      indexVar,
      createConstant(0, PrimitiveTypes.int32),
    ),
  );
  converter.instructions.push(
    new PropertyGetInstruction(lengthVar, keysList, "Count"),
  );

  const loopStart = converter.newLabel("map_entries_start");
  const loopEnd = converter.newLabel("map_entries_end");

  converter.instructions.push(new LabelInstruction(loopStart));
  const condTemp = converter.newTemp(PrimitiveTypes.boolean);
  converter.instructions.push(
    new BinaryOpInstruction(condTemp, indexVar, "<", lengthVar),
  );
  converter.instructions.push(
    new ConditionalJumpInstruction(condTemp, loopEnd),
  );

  // keyToken/valueToken/pairList temps are reused across loop iterations.
  // This is safe because DataList.Add and wrapDataToken copy the current
  // value at call time; overwriting the temp on the next iteration does
  // not affect previously added entries.
  const keyToken = converter.newTemp(ExternTypes.dataToken);
  converter.instructions.push(
    new MethodCallInstruction(keyToken, keysList, "get_Item", [indexVar]),
  );
  const valueToken = converter.newTemp(ExternTypes.dataToken);
  converter.instructions.push(
    new MethodCallInstruction(valueToken, mapOperand, "GetValue", [keyToken]),
  );

  const pairList = converter.newTemp(
    new DataListTypeSymbol(ExternTypes.dataToken),
  );
  converter.instructions.push(new CallInstruction(pairList, listCtorSig, []));
  converter.instructions.push(
    new MethodCallInstruction(undefined, pairList, "Add", [keyToken]),
  );
  converter.instructions.push(
    new MethodCallInstruction(undefined, pairList, "Add", [valueToken]),
  );
  const pairToken = converter.wrapDataToken(pairList);
  converter.instructions.push(
    new MethodCallInstruction(undefined, entriesResult, "Add", [pairToken]),
  );

  converter.instructions.push(
    new BinaryOpInstruction(
      indexVar,
      indexVar,
      "+",
      createConstant(1, PrimitiveTypes.int32),
    ),
  );
  converter.instructions.push(new UnconditionalJumpInstruction(loopStart));
  converter.instructions.push(new LabelInstruction(loopEnd));

  return entriesResult;
};

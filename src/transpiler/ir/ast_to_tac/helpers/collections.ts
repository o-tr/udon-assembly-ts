import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  CollectionTypeSymbol,
  ExternTypes,
} from "../../../frontend/type_symbols.js";
import { UdonType } from "../../../frontend/types.js";

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

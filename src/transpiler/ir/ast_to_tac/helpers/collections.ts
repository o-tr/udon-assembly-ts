import type { TypeSymbol } from "../../../frontend/type_symbols.js";
import {
  CollectionTypeSymbol,
  ExternTypes,
} from "../../../frontend/type_symbols.js";

export const isSetCollectionType = (
  type: TypeSymbol | null,
): type is CollectionTypeSymbol =>
  type instanceof CollectionTypeSymbol &&
  type.name === ExternTypes.dataDictionary.name;

/**
 * Structural type identity for optimizer temp/variable reuse.
 * `udonType` alone is insufficient: NativeArray, Array, and DataList all use
 * a single discriminant udonType while differing by element type.
 */
import {
  ArrayTypeSymbol,
  ClassTypeSymbol,
  CollectionTypeSymbol,
  DataListTypeSymbol,
  NativeArrayTypeSymbol,
  type TypeSymbol,
} from "../../../frontend/type_symbols.js";

/** U+001E Record Separator — not used in Udon/TS type names; avoids nested-key boundary collisions with `|`. */
const RS = "\x1e";

/**
 * Stable string key for a TypeSymbol, used by reuseTemporaries / reuseLocalVariables
 * to avoid merging distinct structural types that share the same `udonType`.
 */
export function structuralTypeKey(t: TypeSymbol | undefined | null): string {
  if (t == null) {
    return "?";
  }
  if (t instanceof NativeArrayTypeSymbol) {
    return `NA${RS}${structuralTypeKey(t.elementType)}`;
  }
  if (t instanceof DataListTypeSymbol) {
    return `DL${RS}${structuralTypeKey(t.elementType)}`;
  }
  if (t instanceof ArrayTypeSymbol) {
    return `AR${RS}${t.dimensions}${RS}${structuralTypeKey(t.elementType)}`;
  }
  if (t instanceof CollectionTypeSymbol) {
    return [
      "Col",
      t.name,
      structuralTypeKey(t.elementType),
      structuralTypeKey(t.keyType),
      structuralTypeKey(t.valueType),
    ].join(RS);
  }
  if (t instanceof ClassTypeSymbol) {
    return `Cls${RS}${String(t.udonType)}${RS}${t.name}`;
  }
  return `${String(t.udonType)}${RS}${t.name}`;
}

/**
 * True when two types must be treated as identical for temp-to-temp copy
 * aliasing and related optimizations (same representation in TAC/UASM).
 */
export function typesStructurallyEqualForTempAlias(
  a: TypeSymbol | undefined | null,
  b: TypeSymbol | undefined | null,
): boolean {
  if (a === b) return true;
  return structuralTypeKey(a) === structuralTypeKey(b);
}

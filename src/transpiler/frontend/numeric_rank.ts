/**
 * C#/.NET numeric promotion rank (higher = wider).
 * Keyed by UdonType string values to avoid circular dependencies
 * between types.ts and type_symbols.ts.
 * Shared by isNumericUdonType (types.ts) and getPromotedType (type_symbols.ts).
 */
export const NUMERIC_RANK: Partial<Record<string, number>> = {
  Byte: 1,
  SByte: 1,
  Int16: 2,
  UInt16: 2,
  Int32: 3,
  UInt32: 3,
  Int64: 4,
  UInt64: 4,
  Single: 5,
  Double: 6,
};

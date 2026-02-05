import type { TACToUdonConverter } from "./converter.js";

export function getConstantKey(
  this: TACToUdonConverter,
  value: unknown, typeName: string
): string {
  if (typeof value === "bigint") {
    return `${typeName}|bigint:${value.toString()}`;
  }
  return `${typeName}|${JSON.stringify(value)}`;
}

export function parseConstantKey(
  this: TACToUdonConverter,
  key: string
): unknown {
  const payload = this.getConstantKeyPayload(key);
  if (payload.startsWith("bigint:")) {
    return BigInt(payload.slice("bigint:".length));
  }
  return JSON.parse(payload);
}

export function getConstantKeyPayload(
  this: TACToUdonConverter,
  key: string
): string {
  const sep = key.indexOf("|");
  if (sep === -1) {
    return key;
  }
  return key.slice(sep + 1);
}

export function formatInt64HexConstant(
  this: TACToUdonConverter,
  key: string, rawValue: unknown
): string {
  let value: bigint;

  const payload = this.getConstantKeyPayload(key);

  if (payload.startsWith("bigint:")) {
    value = BigInt(payload.slice("bigint:".length));
  } else if (typeof rawValue === "string") {
    if (rawValue.startsWith("0x") || rawValue.startsWith("0X")) {
      return rawValue;
    }
    value = BigInt(rawValue);
  } else if (typeof rawValue === "number") {
    // Use the numeric value directly; parsing the key is fragile
    // (key can be JSON for objects/arrays). Always truncate to
    // integer part and convert to BigInt.
    value = BigInt(Math.trunc(rawValue));
  } else if (typeof rawValue === "bigint") {
    value = rawValue;
  } else {
    value = 0n;
  }

  const mask = (1n << 64n) - 1n;
  const normalized = value & mask;
  const hex = normalized.toString(16).toUpperCase().padStart(16, "0");
  return `0x${hex}`;
}

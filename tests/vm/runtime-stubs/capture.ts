/**
 * Log capture infrastructure for JS runtime tests.
 *
 * Debug.Log calls are routed through captureLog(), which formats values
 * to match the Udon VM's C# string representation.
 */

const capturedLogs: string[] = [];

export function captureLog(value: unknown): void {
  capturedLogs.push(formatForUdon(value));
}

export function getCapturedLogs(): string[] {
  return [...capturedLogs];
}

export function clearCapturedLogs(): void {
  capturedLogs.length = 0;
}

/**
 * Format a value to match Udon VM (C#) string output.
 *
 * Key differences from JS defaults:
 * - boolean: "True" / "False" (C# Boolean.ToString())
 * - number: JS toString() is generally compatible with C# float.ToString()
 *   for the values used in tests (whole numbers omit decimal, fractional keep it)
 * - Vector3: "(x.xx, y.yy, z.zz)" format
 * - null/undefined: "Null"
 */
export function formatForUdon(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number") {
    return value.toString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === null || value === undefined) {
    return "Null";
  }
  // Objects with custom toString (e.g., Vector3)
  return String(value);
}

/**
 * Format a value for use in template literals, matching Udon VM behavior.
 *
 * In the Udon VM, template literals are compiled to String.Concat chains,
 * so each interpolated value goes through C#'s .ToString().
 * In JS, template literals use the internal ToString abstract operation
 * which differs for booleans (lowercase vs uppercase).
 */
export function udonFormat(value: unknown): string {
  return formatForUdon(value);
}

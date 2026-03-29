/**
 * Log capture infrastructure for JS runtime tests.
 *
 * Debug.Log calls are routed through captureLog(), which formats values
 * to match the Udon VM's C# string representation.
 */

/**
 * capturedLogs is a module-level singleton. Correct usage requires:
 *   1. clearCapturedLogs() is called before each test case.
 *   2. runTestCaseInJs calls are sequential, not concurrent.
 *
 * runAllTestCasesInJs() enforces sequentiality via a for...of loop.
 * Concurrent callers (e.g. Promise.all) would corrupt log capture.
 */
let isCapturing = false;
const capturedLogs: string[] = [];

export function captureLog(value: unknown): void {
  capturedLogs.push(formatForUdon(value));
}

export function getCapturedLogs(): string[] {
  return [...capturedLogs];
}

export function clearCapturedLogs(): void {
  if (isCapturing) {
    throw new Error(
      "clearCapturedLogs() called while another runTestCaseInJs() is still running. " +
        "Concurrent test execution is not supported — use sequential await.",
    );
  }
  capturedLogs.length = 0;
}

/** Mark capture session start (called by runTestCaseInJs). */
export function beginCapture(): void {
  if (isCapturing) {
    throw new Error(
      "beginCapture() called while already capturing. " +
        "Concurrent runTestCaseInJs() calls are not supported.",
    );
  }
  isCapturing = true;
  capturedLogs.length = 0;
}

/** Mark capture session end (called by runTestCaseInJs). */
export function endCapture(): void {
  isCapturing = false;
}

/**
 * Format a value to match Udon VM (C#) string output.
 *
 * Key differences from JS defaults:
 * - boolean: "True" / "False" (C# Boolean.ToString())
 * - number: formatted as C# float.ToString() — G7 with 7 significant digits,
 *   scientific notation for |exp| >= 7 or exp < -4 (e.g. "1E+07", "1E-05").
 *   IMPORTANT: test case source files should use only exact binary-fraction
 *   float literals (e.g. 3.25, 7.5, 0.125) to guarantee that JS and C#
 *   produce the same string. Non-exact fractions like 1.1 may diverge even
 *   with G7 formatting due to single-precision rounding differences.
 *   IMPORTANT for integer values (UdonInt): TypeScript branded types are erased
 *   at runtime, so all JS numbers pass through Math.fround() here. Integers
 *   larger than 2^24 (16,777,216) lose precision when converted to float32 —
 *   e.g. formatSingle(16_777_217 as UdonInt) produces "16777216" while C#'s
 *   int.ToString() produces "16777217". Keep integer test values below 2^24.
 * - Vector3: "(x.xx, y.yy, z.zz)" format
 * - null/undefined: "Null"
 */
export function formatForUdon(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number") {
    return formatSingle(value);
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
 * Format a JS number as C# float.ToString() — i.e., G7 (7 significant digits).
 *
 * Rules (matching C# "G" format for System.Single):
 *   - Finite values: 7 significant digits
 *   - Fixed notation when -4 ≤ exponent < 7
 *   - Scientific notation otherwise: "1.234568E+07", "1E-05"
 *   - Trailing zeros in the mantissa are stripped
 */
function formatSingle(v: number): string {
  if (!Number.isFinite(v)) {
    if (v > 0) return "Infinity";
    if (v < 0) return "-Infinity";
    return "NaN";
  }
  if (v === 0) return "0"; // handles both +0 and -0

  const fv = Math.fround(v);

  // Derive exponent from toExponential() rather than Math.log10() to avoid
  // floating-point precision loss at power-of-10 boundaries (e.g., 1e7 can
  // yield log10 = 6.9999... causing Math.floor to return 6 instead of 7).
  const exp = parseInt(fv.toExponential().split("e")[1], 10);

  if (exp >= 7 || exp < -4) {
    // Scientific notation — toExponential(6) gives 6 decimal places = 7 sig digits
    const sci = fv.toExponential(6);
    // Strip trailing zeros in the mantissa: "1.000000e+7" → "1e+7"
    const stripped = sci
      .replace(/(\.\d*?)0+(e)/, "$1$2")
      .replace(/\.(e)/, "$1");
    // Uppercase E, zero-pad single-digit exponent: e+7 → E+07, e-5 → E-05
    return stripped
      .replace("e+", "E+")
      .replace("e-", "E-")
      .replace(/E([+-])(\d)$/, "E$10$2");
  }

  // Fixed notation: toPrecision(7) → strip trailing zeros via parseFloat
  return parseFloat(fv.toPrecision(7)).toString();
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

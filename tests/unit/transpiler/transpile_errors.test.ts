/**
 * Unit tests for transpile error types
 */

import { describe, expect, it } from "vitest";
import {
  DuplicateTopLevelConstError,
  type TranspileErrorLocation,
} from "../../../src/transpiler/errors/transpile_errors";

describe("DuplicateTopLevelConstError", () => {
  it("toTranspileErrors should produce two TranspileErrors with correct locations and messages", () => {
    const locationA: TranspileErrorLocation = {
      filePath: "src/Alpha.ts",
      line: 3,
      column: 7,
    };
    const locationB: TranspileErrorLocation = {
      filePath: "src/Beta.ts",
      line: 5,
      column: 1,
    };

    const err = new DuplicateTopLevelConstError("MY_CONST", locationA, locationB);
    const [errA, errB] = err.toTranspileErrors();

    // Both errors should be TypeError
    expect(errA.code).toBe("TypeError");
    expect(errB.code).toBe("TypeError");

    // errA points to locationA, mentions locationB's file
    expect(errA.location).toEqual(locationA);
    expect(errA.message).toContain("MY_CONST");
    expect(errA.message).toContain("src/Beta.ts");

    // errB points to locationB, mentions locationA's file
    expect(errB.location).toEqual(locationB);
    expect(errB.message).toContain("MY_CONST");
    expect(errB.message).toContain("src/Alpha.ts");

    // Both should carry a suggestion
    expect(errA.suggestion).toBe("Rename one of the conflicting declarations");
    expect(errB.suggestion).toBe("Rename one of the conflicting declarations");
  });
});

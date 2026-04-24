/**
 * Unit tests for transpile error types
 */

import { describe, expect, it } from "vitest";
import {
  DuplicateTopLevelConstError,
  formatWarnings,
  type TranspileErrorLocation,
  type TranspileWarning,
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

    const err = new DuplicateTopLevelConstError(
      "MY_CONST",
      locationA,
      locationB,
    );
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

describe("formatWarnings", () => {
  const baseWarning: TranspileWarning = {
    code: "UntrackedStructuralUnionReturn",
    message:
      "untracked variable returned as structural union — relying on sibling returns to populate the unified return prefix; ensure null narrowing guards this path.",
    location: { filePath: "src/Main.ts", line: 10, column: 5 },
    context: { className: "Main", methodName: "Start" },
  };

  it("returns empty string for no warnings", () => {
    expect(formatWarnings([])).toBe("");
  });

  it("formats a single warning without suffix", () => {
    const out = formatWarnings([baseWarning]);
    expect(out).toContain("Transpile produced 1 warning(s):");
    expect(out).toContain("[UntrackedStructuralUnionReturn]");
    expect(out).not.toContain("(x");
  });

  it("deduplicates identical warnings with (xN) suffix", () => {
    const warnings: TranspileWarning[] = [
      baseWarning,
      { ...baseWarning },
      { ...baseWarning },
    ];
    const out = formatWarnings(warnings);
    expect(out).toContain("Transpile produced 3 warning(s):");
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("(x3)");
  });

  it("keeps distinct warnings separate", () => {
    const w2: TranspileWarning = {
      ...baseWarning,
      message: "different message",
    };
    const out = formatWarnings([baseWarning, baseWarning, w2]);
    expect(out).toContain("Transpile produced 3 warning(s):");
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes("(x2)"))).toBe(true);
    expect(lines.some((l) => l.includes("different message"))).toBe(true);
  });
});

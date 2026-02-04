import { describe, expect, it } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler";

describe("Local slot reuse", () => {
  it("reuses local heap slots when optimized", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      class Demo {
        Start(): void {
          let a: number = 1;
          let b: number = a + 2;
          let c: number = b + 3;
        }
      }
    `;

    const result = transpiler.transpile(source, { optimize: true });

    const lines = result.uasm.split("\n");
    const dataStartIdx = lines.findIndex((l) => l.includes(".data_start"));
    const dataEndIdx = lines.findIndex((l) => l.includes(".data_end"));
    const dataLines = lines.slice(dataStartIdx, dataEndIdx + 1);
    const localSlots = dataLines.filter((line) =>
      line.trim().startsWith("__l"),
    );

    expect(localSlots.length).toBeGreaterThan(0);
    expect(localSlots.length).toBeLessThan(3);
    expect(result.uasm).not.toContain("a: %");
    expect(result.uasm).not.toContain("b: %");
    expect(result.uasm).not.toContain("c: %");
  });
});

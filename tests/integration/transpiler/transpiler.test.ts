/**
 * Integration tests for TypeScript to Udon transpiler
 */

import { describe, expect, it } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler";

describe("TypeScript to Udon Transpiler Integration", () => {
  it("should transpile simple variable declaration to .uasm", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = "let x: number = 10;";

    const result = transpiler.transpile(source);

    // Check TAC output
    expect(result.tac).toContain("x");
    expect(result.tac).toContain("10");

    // Check .uasm output
    expect(result.uasm).toContain(".data_start");
    expect(result.uasm).toContain(".data_end");
    expect(result.uasm).toContain(".code_start");
    expect(result.uasm).toContain(".code_end");
    expect(result.uasm).toContain("PUSH");
    expect(result.uasm).toContain("COPY");
  });

  it("should transpile arithmetic expression to .uasm", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      let x: number = 10;
      let y: number = 20;
      let z: number = x + y;
    `;

    const result = transpiler.transpile(source);

    // Check for variable declarations in data section
    expect(result.uasm).toContain("x: %SystemSingle");
    expect(result.uasm).toContain("y: %SystemSingle");
    expect(result.uasm).toContain("z: %SystemSingle");

    // Check for EXTERN instruction with proper signature
    expect(result.uasm).toContain("EXTERN");
    expect(result.uasm).toContain("op_Addition");
  });

  it("should transpile conditional statement to .uasm", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      let x: number = 10;
      let y: number = 20;
      if (x < y) {
        let z: number = x + y;
      }
    `;

    const result = transpiler.transpile(source);

    // Check for comparison extern with proper operator name
    expect(result.uasm).toContain("op_LessThan");

    // Check for conditional jump with hex address
    expect(result.uasm).toContain("JUMP");

    // Check for labels
    const lines = result.uasm.split("\n");
    const hasLabels = lines.some(
      (line) => line.trim().endsWith(":") && !line.includes("_start:"),
    );
    expect(hasLabels).toBe(true);
  });

  it("should transpile while loop to .uasm", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      let i: number = 0;
      while (i < 10) {
        i = i + 1;
      }
    `;

    const result = transpiler.transpile(source);

    // Check for loop labels
    const lines = result.uasm.split("\n");
    const labels = lines.filter((line) => line.trim().endsWith(":"));
    expect(labels.length).toBeGreaterThanOrEqual(2); // Start and end labels (including _start)

    // Check for comparison and addition externs with proper operator names
    expect(result.uasm).toContain("op_LessThan");
    expect(result.uasm).toContain("op_Addition");
  });

  it("should optimize constant folding when enabled", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source =
      "let result: number = 5 + 3; if (result > 0) { result = result; }";

    const resultOptimized = transpiler.transpile(source, { optimize: true });
    const resultUnoptimized = transpiler.transpile(source, { optimize: false });

    // Optimized version should fold or eliminate 5 + 3
    expect(resultOptimized.tac).not.toContain("5 + 3");

    // Unoptimized version should keep the operation
    expect(resultUnoptimized.tac).toContain("+");
  });

  it("should handle multiple variables and expressions", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      let a: number = 5;
      let b: number = 10;
      let c: number = 15;
      let result: number = a + b + c;
    `;

    const result = transpiler.transpile(source);

    // Check all variables are present
    expect(result.tac).toContain("a");
    expect(result.tac).toContain("b");
    expect(result.tac).toContain("c");
    expect(result.tac).toContain("result");

    // Check .uasm is valid
    expect(result.uasm).toContain(".data_start");
    expect(result.uasm).toContain(".code_start");
  });

  it("should handle nested if statements", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      let x: number = 10;
      if (x > 5) {
        if (x < 20) {
          let y: number = 15;
        }
      }
    `;

    const result = transpiler.transpile(source);

    // Should have multiple labels for nested blocks
    const lines = result.uasm.split("\n");
    const labels = lines.filter((line) => line.trim().endsWith(":"));
    expect(labels.length).toBeGreaterThan(2);

    // Should have comparison externs with proper operator names
    expect(result.uasm).toContain("op_GreaterThan");
    expect(result.uasm).toContain("op_LessThan");
  });

  it("should handle const declarations", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      const PI: number = 3.14;
      let radius: number = 5;
      let area: number = PI * radius;
    `;

    const result = transpiler.transpile(source);

    // Literal const PI is inlined as 3.14 directly
    expect(result.tac).toContain("3.14");

    // Check .uasm is generated with proper operator name
    expect(result.uasm).toContain(".code_start");
    expect(result.uasm).toContain("op_Multiply");
  });

  it("should generate valid .uasm structure for complex program", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      let sum: number = 0;
      let i: number = 1;
      while (i < 5) {
        sum = sum + i;
        i = i + 1;
      }
    `;

    const result = transpiler.transpile(source);

    // Verify .uasm structure
    const lines = result.uasm.split("\n");

    // Find section markers
    const dataStartIdx = lines.findIndex((l) => l.includes(".data_start"));
    const dataEndIdx = lines.findIndex((l) => l.includes(".data_end"));
    const codeStartIdx = lines.findIndex((l) => l.includes(".code_start"));
    const codeEndIdx = lines.findIndex((l) => l.includes(".code_end"));

    // All sections should exist
    expect(dataStartIdx).toBeGreaterThanOrEqual(0);
    expect(dataEndIdx).toBeGreaterThan(dataStartIdx);
    expect(codeStartIdx).toBeGreaterThan(dataEndIdx);
    expect(codeEndIdx).toBeGreaterThan(codeStartIdx);

    // Data section should have variable declarations (not .extern)
    const dataSection = lines.slice(dataStartIdx, dataEndIdx + 1).join("\n");
    expect(dataSection).toContain(": %System");
    expect(dataSection).toContain(".export");
    expect(dataSection).toContain(".sync");

    // Code section should have instructions
    const codeSection = lines.slice(codeStartIdx, codeEndIdx + 1).join("\n");
    expect(codeSection).toContain("PUSH");

    // Check for entry point
    expect(codeSection).toContain(".export _start");
    expect(codeSection).toContain("_start:");
  });
});

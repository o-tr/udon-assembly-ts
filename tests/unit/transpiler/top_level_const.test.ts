import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler";

describe("Top-level const variables", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("inlines numeric literal constants", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      const MAX = 100;
      class TestClass {
        Start(): void {
          let x: number = MAX;
        }
      }
    `;
    const result = transpiler.transpile(source);
    // The TAC should inline the constant value 100 directly
    expect(result.tac).toContain("100");
    // Should NOT have an assignment to a variable named MAX
    expect(result.tac).not.toMatch(/MAX\s*=/);
  });

  it("inlines string literal constants", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      const MSG = "hello";
      class TestClass {
        Start(): void {
          let s: string = MSG;
        }
      }
    `;
    const result = transpiler.transpile(source);
    expect(result.tac).toContain('"hello"');
    expect(result.tac).not.toMatch(/MSG\s*=/);
  });

  it("inlines boolean literal constants", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      const DEBUG = true;
      class TestClass {
        Start(): void {
          let flag: boolean = DEBUG;
        }
      }
    `;
    const result = transpiler.transpile(source);
    expect(result.tac).toContain("true");
    expect(result.tac).not.toMatch(/DEBUG\s*=/);
  });

  it("initializes non-literal constants at _start", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      const FACTOR = 2 + 3;
      class TestClass {
        Start(): void {
          let y: number = FACTOR;
        }
      }
    `;
    const result = transpiler.transpile(source);
    // FACTOR should appear as a variable (not inlined) since it's non-literal
    expect(result.tac).toContain("FACTOR");
    // The _start label should exist
    expect(result.tac).toContain("_start:");
  });

  it("handles multiple constants across multiple methods", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      const A = 1;
      const B = 2;
      class TestClass {
        Start(): void {
          let x: number = A;
        }
        Update(): void {
          let y: number = B;
        }
      }
    `;
    const result = transpiler.transpile(source);
    // Both constants should be inlined
    expect(result.tac).not.toMatch(/\bA\s*=/);
    expect(result.tac).not.toMatch(/\bB\s*=/);
  });

  it("inlines constants used in expressions", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      const SCALE = 5;
      class TestClass {
        Start(): void {
          let r: number = SCALE * 2;
        }
      }
    `;
    const result = transpiler.transpile(source);
    // SCALE should be inlined as the constant 5
    expect(result.tac).toContain("5");
    expect(result.tac).toContain("2");
    expect(result.tac).not.toMatch(/SCALE\s*=/);
  });

  it("generates valid UASM output structure", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    const source = `
      const MAX = 100;
      class TestClass {
        Start(): void {
          let x: number = MAX;
        }
      }
    `;
    const result = transpiler.transpile(source);
    expect(result.uasm).toContain(".data_start");
    expect(result.uasm).toContain(".data_end");
    expect(result.uasm).toContain(".code_start");
    expect(result.uasm).toContain(".code_end");
    expect(result.uasm).toContain("_start:");
  });
});

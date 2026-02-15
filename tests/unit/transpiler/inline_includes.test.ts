import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("inline constant array .includes() optimization", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("string 3-element includes becomes equality chain", () => {
    const source = `
      import { UdonBehaviour } from "udon-assembly-ts/stubs/UdonBehaviour";
      class Test extends UdonBehaviour {
        result: boolean = false;
        Start(): void {
          const x: string = "test";
          this.result = ["a", "b", "c"].includes(x);
        }
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);
    // Should NOT contain DataList construction
    expect(result.tac).not.toContain("DataList");
    // Should contain == comparisons (Udon uses == not ===)
    expect(result.tac).toContain("==");
    // Should contain bitwise OR for boolean chaining (match " | " to avoid false positives)
    expect(result.tac).toMatch(/\S+ \| \S+/);
  });

  it("numeric includes becomes equality chain", () => {
    const source = `
      import { UdonBehaviour } from "udon-assembly-ts/stubs/UdonBehaviour";
      class Test extends UdonBehaviour {
        result: boolean = false;
        Start(): void {
          const n: number = 42;
          this.result = [1, 2, 3].includes(n);
        }
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);
    expect(result.tac).not.toContain("DataList");
    expect(result.tac).toContain("==");
  });

  it("single-element includes becomes single comparison", () => {
    const source = `
      import { UdonBehaviour } from "udon-assembly-ts/stubs/UdonBehaviour";
      class Test extends UdonBehaviour {
        result: boolean = false;
        Start(): void {
          const x: string = "test";
          this.result = ["a"].includes(x);
        }
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);
    expect(result.tac).not.toContain("DataList");
    expect(result.tac).toContain("==");
  });

  it("non-literal elements fall back to DataList", () => {
    const source = `
      import { UdonBehaviour } from "udon-assembly-ts/stubs/UdonBehaviour";
      class Test extends UdonBehaviour {
        result: boolean = false;
        Start(): void {
          const a: string = "x";
          const b: string = "y";
          const x: string = "test";
          this.result = [a, b].includes(x);
        }
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);
    // Should use DataList since elements are not literals
    expect(result.tac).toContain("DataList");
  });
});

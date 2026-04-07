import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("typed array spread → .concat() optimization", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("two typed arrays use DataList loop concat", () => {
    const source = `
      import { UdonBehaviour } from "udon-assembly-ts/stubs/UdonBehaviour";
      class Test extends UdonBehaviour {
        Start(): void {
          const a: number[] = [1, 2];
          const b: number[] = [3, 4];
          const result: number[] = [...a, ...b];
          this.log(result.length);
        }
        log(n: number): void {}
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);
    // Spread now uses DataList loop concat (get_Item + Add)
    expect(result.tac).toContain("get_Item");
    expect(result.tac).toContain("Add");
    expect(result.tac).toContain("dlconcat_start");
    expect(result.tac).not.toContain("SystemArray");
  });

  it("three typed arrays produce three DataList loop concats", () => {
    const source = `
      import { UdonBehaviour } from "udon-assembly-ts/stubs/UdonBehaviour";
      class Test extends UdonBehaviour {
        Start(): void {
          const a: number[] = [1];
          const b: number[] = [2];
          const c: number[] = [3];
          const result: number[] = [...a, ...b, ...c];
          this.log(result.length);
        }
        log(n: number): void {}
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);
    // Three spread operands produce three DataList loop concat blocks
    const loopCount = (result.tac.match(/dlconcat_start/g) || []).length;
    expect(loopCount).toBeGreaterThanOrEqual(3);
    expect(result.tac).not.toContain("SystemArray");
  });

  it("mixed spread and literal falls back to DataList loop", () => {
    const source = `
      import { UdonBehaviour } from "udon-assembly-ts/stubs/UdonBehaviour";
      class Test extends UdonBehaviour {
        Start(): void {
          const a: number[] = [1, 2];
          const result: number[] = [...a, 42];
          this.log(result.length);
        }
        log(n: number): void {}
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);
    // Mixed spread+literal should use DataList fallback, not Array.Copy concat
    expect(result.tac).not.toContain("SystemArray");
    expect(result.tac).toContain("Add");
  });

  it("single spread falls back to DataList loop", () => {
    const source = `
      import { UdonBehaviour } from "udon-assembly-ts/stubs/UdonBehaviour";
      class Test extends UdonBehaviour {
        Start(): void {
          const a: number[] = [1, 2];
          const result: number[] = [...a];
          this.log(result.length);
        }
        log(n: number): void {}
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);
    // Single spread should use DataList fallback, not Array.Copy concat
    expect(result.tac).not.toContain("SystemArray");
    expect(result.tac).toContain("Add");
  });
});

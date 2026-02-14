import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("typed array spread → .concat() optimization", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("two typed arrays become concat", () => {
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
    // The spread should use concat instead of a DataList loop
    expect(result.tac).toContain("concat");
  });

  it("three typed arrays become concat chain", () => {
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
    // Should have two concat calls in chain
    const concatCount = (result.tac.match(/concat/g) || []).length;
    expect(concatCount).toBe(2);
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
    // Mixed spread+literal should NOT use concat optimization
    expect(result.tac).not.toContain("concat");
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
    // Single spread (elements.length < 2) should not use concat
    expect(result.tac).not.toContain("concat");
  });
});

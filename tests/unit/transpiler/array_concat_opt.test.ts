import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("typed array spread → .concat() optimization", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("two typed arrays become loop-based concat", () => {
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
    // The spread should use loop-based concat via DataList iteration.
    // Verify loop labels are present and old EXTERN concat is absent.
    const concatLoops = (result.tac.match(/concat_a_start/g) || []).length;
    expect(concatLoops).toBeGreaterThanOrEqual(1);
    expect(result.tac).not.toContain("MethodCall concat");
  });

  it("three typed arrays become two concat loops", () => {
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
    // Should have at least two loop-based concat operations and no EXTERN concat
    const concatStartCount = (result.tac.match(/concat_a_start/g) || []).length;
    expect(concatStartCount).toBeGreaterThanOrEqual(2);
    expect(result.tac).not.toContain("MethodCall concat");
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

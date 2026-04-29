/**
 * Tests for inline recursive static method handling.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("inline recursive static method", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("handles inherited recursive static method via derived class", () => {
    const source = `
      class Base {
        static factorial(n: number): number {
          if (n <= 1) {
            return 1;
          }
          return n * Base.factorial(n - 1);
        }
      }
      class Derived extends Base {}
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const r: number = Derived.factorial(5);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });

    expect(result.tac).toContain("__inlineRec_Base_factorial");
    expect(result.tac).toContain("__inlineRec_Base_factorial_selfCallResult_");
  });
});

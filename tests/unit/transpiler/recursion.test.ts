/**
 * Recursive method support tests
 */

import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import { TACInstructionKind } from "../../../src/transpiler/ir/tac_instruction";

describe("recursive methods", () => {
  it("should emit recursion stack handling", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        @RecursiveMethod
        factorial(n: number): number {
          if (n <= 1) return 1;
          return n * this.factorial(n - 1);
        }
      }
    `;
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    // Recursion stacks are pre-populated with DataList.Add at method entry.
    const hasStackAlloc = tac.some(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        inst.toString().includes("Add"),
    );

    expect(hasStackAlloc).toBe(true);
  });

  it("should emit JUMP-based dispatch for entry-point class", () => {
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";

      function RecursiveMethod(_t: object, _k: string, d: PropertyDescriptor): PropertyDescriptor { return d; }

      @UdonBehaviour()
      export class Factorial extends UdonSharpBehaviour {
        @RecursiveMethod
        factorial(n: number): number {
          if (n <= 1) return 1;
          return n * this.factorial(n - 1);
        }

        Start(): void {
          this.factorial(5);
        }
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);

    // The UASM should contain: JUMP to the method, dispatch table checks,
    // JUMP_IF_FALSE for each return site, and JUMP 0xFFFFFFFC as fallback.
    expect(result.uasm).toContain("JUMP,");
    expect(result.uasm).toContain("JUMP_IF_FALSE,");
    expect(result.uasm).toContain("JUMP, 0xFFFFFFFC");
    // Return site index variable and inequality check for dispatch
    expect(result.uasm).toContain("__returnSiteIdx_factorial");
    expect(result.uasm).toContain("Inequality");
    // Call-site push/pop via DataList set_Item/get_Item
    expect(result.uasm).toContain("set_Item");
    expect(result.uasm).toContain("get_Item");
  });
});

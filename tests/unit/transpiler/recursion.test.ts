/**
 * Recursive method support tests
 */

import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
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
    // Push/pop (set_Item/get_Item) happens at each call site for entry-point classes.
    const hasStackAlloc = tac.some(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        inst.toString().includes("Add"),
    );

    expect(hasStackAlloc).toBe(true);
  });
});

/**
 * Recursive method support tests
 */

import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac";
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

    const hasArraySet = tac.some(
      (inst) => inst.kind === TACInstructionKind.ArrayAssignment,
    );
    const hasArrayGet = tac.some(
      (inst) => inst.kind === TACInstructionKind.ArrayAccess,
    );

    expect(hasArraySet).toBe(true);
    expect(hasArrayGet).toBe(true);
  });
});

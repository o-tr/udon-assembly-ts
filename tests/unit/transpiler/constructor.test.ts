/**
 * Constructor support tests
 */

import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac";
import { TACInstructionKind } from "../../../src/transpiler/ir/tac_instruction";

describe("constructors", () => {
  it("should inline property initialization and constructor body", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Foo {
        x: number = 1;
        constructor(a: number) {
          this.x = a;
        }
      }
      class Main {
        Start(): void {
          const foo = new Foo(3);
        }
      }
    `;
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const assignments = tac.filter(
      (inst) => inst.kind === TACInstructionKind.Assignment,
    );
    const hasInlineField = assignments.some((inst) =>
      inst.toString().includes("__inst_Foo_"),
    );

    expect(hasInlineField).toBe(true);
  });
});

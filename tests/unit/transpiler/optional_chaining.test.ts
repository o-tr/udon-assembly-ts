import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";

const stringify = (tac: { toString(): string }[]) =>
  tac.map((inst) => inst.toString()).join("\n");

describe("optional chaining", () => {
  it("expands obj?.prop with null checks", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          let obj: object = this as object;
          let value = obj?.prop;
        }
      }
    `;
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const tacText = stringify(tac);

    expect(tacText).toContain("opt_notnull");
    expect(tacText).toContain("opt_end");
    expect(tacText).toContain("prop");
  });
});

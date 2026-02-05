import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import { TACInstructionKind } from "../../../src/transpiler/ir/tac_instruction";

describe("template literal folding", () => {
  it("folds constant template literals into a single string", () => {
    const source = `
      class Demo {
        Start(): void {
          let msg: string = \`Hello ${1} ${true}\`;
        }
      }
    `;

    const parser = new TypeScriptParser();
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const concatCall = tac.find(
      (inst) =>
        inst.kind === TACInstructionKind.Call &&
        inst
          .toString()
          .includes(
            "SystemString.__Concat__SystemString_SystemString__SystemString",
          ),
    );
    expect(concatCall).toBeUndefined();

    const text = tac.map((inst) => inst.toString()).join("\n");
    expect(text).toContain('"Hello 1 true"');
  });
});

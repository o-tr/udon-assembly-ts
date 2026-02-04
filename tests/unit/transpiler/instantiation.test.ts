import { describe, expect, it } from "vitest";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac";

describe("InstantiationShim", () => {
  it("emits VRCInstantiate extern for Instantiate calls", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          const obj = Instantiate(this.gameObject);
        }
      }
    `;
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const udonConverter = new TACToUdonConverter();
    udonConverter.convert(tac);
    const externs = udonConverter.getExternSignatures();

    expect(
      externs.some((sig) =>
        sig.includes(
          "VRCInstantiate.__Instantiate__UnityEngineGameObject__UnityEngineGameObject",
        ),
      ),
    ).toBe(true);
  });
});

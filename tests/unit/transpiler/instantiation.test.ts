import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon/index.js";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";

describe("InstantiationShim", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

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

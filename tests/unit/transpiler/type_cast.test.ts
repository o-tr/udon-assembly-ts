/**
 * Type cast (as) support tests
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac";

describe("type casts", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("should preserve type info for method calls after cast", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        obj: object;
        Start(): void {
          const player = this.obj as VRCPlayerApi;
          player.GetPosition();
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
          "VRCSDKBaseVRCPlayerApi.__GetPosition____UnityEngineVector3",
        ),
      ),
    ).toBe(true);
  });
});

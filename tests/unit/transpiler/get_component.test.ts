/**
 * GetComponent<T> shim tests
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon/index.js";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";

const GET_COMPONENT_EXTERN =
  "UdonSharpLibInternalGetComponentShim.__GetComponent__UnityEngineComponent_SystemInt64__UnityEngineComponent";

describe("GetComponent<T>", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("should emit GetComponent extern signature", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          this.GetComponent<AudioSource>();
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

    expect(externs.some((sig) => sig.includes(GET_COMPONENT_EXTERN))).toBe(
      true,
    );
  });
});

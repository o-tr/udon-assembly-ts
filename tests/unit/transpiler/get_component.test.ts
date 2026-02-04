/**
 * GetComponent<T> shim tests
 */

import { describe, expect, it } from "vitest";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac";

const GET_COMPONENT_EXTERN =
  "UdonSharpLibInternalGetComponentShim.__GetComponent__UnityEngineComponent_SystemInt64__UnityEngineComponent";

describe("GetComponent<T>", () => {
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

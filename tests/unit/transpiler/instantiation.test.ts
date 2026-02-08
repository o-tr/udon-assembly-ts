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

  it("lowers new Array(length) to empty DataList", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          const list = new Array(3);
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
        sig.includes("VRCSDK3DataDataList.__ctor____VRCSDK3DataDataList"),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "VRCSDK3DataDataList.__Add__VRCSDK3DataDataToken__SystemVoid",
        ),
      ),
    ).toBe(false);
  });

  it("lowers Array(length) without new to empty DataList", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          const list = Array(3);
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
        sig.includes("VRCSDK3DataDataList.__ctor____VRCSDK3DataDataList"),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "VRCSDK3DataDataList.__Add__VRCSDK3DataDataToken__SystemVoid",
        ),
      ),
    ).toBe(false);
  });

  it("treats new Array(value) as single element when non-numeric", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          const list = new Array("x");
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
        sig.includes("VRCSDK3DataDataList.__ctor____VRCSDK3DataDataList"),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "VRCSDK3DataDataList.__Add__VRCSDK3DataDataToken__SystemVoid",
        ),
      ),
    ).toBe(true);
  });

  it("emits runtime floor check for new Array(floatVar)", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          const n: number = 3.0;
          const list = new Array(n);
        }
      }
    `;
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const tacText = tac.map((i) => i.toString()).join("\n");

    // Should emit Math.floor call and conditional jump for runtime integer check
    expect(tacText).toContain("Floor");
    expect(tacText).toContain("ifFalse");
    expect(tacText).toContain("array_non_int_length");
    expect(tacText).toContain("array_length_done");
  });
});

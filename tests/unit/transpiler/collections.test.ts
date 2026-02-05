import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon/index.js";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";

describe("collections support", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("emits DataList/DataDictionary externs", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          let list: DataList = new DataList();
          list.Add(42);
          let count: number = list.Count;
          let dict: DataDictionary = new DataDictionary();
          dict.SetValue("a", 1);
          dict.ContainsKey("a");
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
          "VRCSDK3DataDataDictionary.__ctor____VRCSDK3DataDataDictionary",
        ),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "VRCSDK3DataDataToken.__ctor__SystemSingle__VRCSDK3DataDataToken",
        ),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "VRCSDK3DataDataList.__Add__VRCSDK3DataDataToken__SystemVoid",
        ),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "VRCSDK3DataDataDictionary.__SetValue__VRCSDK3DataDataToken_VRCSDK3DataDataToken__SystemVoid",
        ),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "VRCSDK3DataDataDictionary.__ContainsKey__VRCSDK3DataDataToken__SystemBoolean",
        ),
      ),
    ).toBe(true);
  });

  it("emits UdonSharp collection externs and indexers", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          let list: UdonList<number> = new UdonList<number>();
          list.Add(1);
          let first: number = list[0];
          list[0] = 2;
          let count: number = list.Count;
          let dict: UdonDictionary<string, number> = new UdonDictionary<string, number>();
          dict.Add("a", 1);
          let value: number = dict["a"];
          dict["a"] = 2;
          dict.ContainsKey("a");
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
        sig.includes("UdonSharpRuntime_List.__Add__T__SystemVoid"),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes("UdonSharpRuntime_List.__get_Item__SystemInt32__T"),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "UdonSharpRuntime_List.__set_Item__SystemInt32_T__SystemVoid",
        ),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes("UdonSharpRuntime_List.__get_Count____SystemInt32"),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "UdonSharpRuntime_Dictionary.__Add__TKey_TValue__SystemVoid",
        ),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes("UdonSharpRuntime_Dictionary.__get_Item__TKey__TValue"),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "UdonSharpRuntime_Dictionary.__set_Item__TKey_TValue__SystemVoid",
        ),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "UdonSharpRuntime_Dictionary.__ContainsKey__TKey__SystemBoolean",
        ),
      ),
    ).toBe(true);
  });
});

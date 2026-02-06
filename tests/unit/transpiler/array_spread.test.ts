import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";

describe("array spread diagnostics", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("errors when spreading a numeric property (improved message)", () => {
    const parser = new TypeScriptParser();
    const source = `let obj: { value: number } = { value: 1 }; let arr = [...obj.value];`;
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    expect(() => converter.convert(ast)).toThrowError(
      /Array spread expects.*obj\.value.*resolved to.*\(/,
    );
  });

  it("allows spreading an array variable", () => {
    const parser = new TypeScriptParser();
    const source = `let nums: number[] = [1,2,3]; let arr = [...nums];`;
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    expect(tac).toBeDefined();
  });
});

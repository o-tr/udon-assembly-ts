import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import { TACInstructionKind } from "../../../src/transpiler/ir/tac_instruction";

describe("expression lowering", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("handles conditional expressions", () => {
    const parser = new TypeScriptParser();
    const source = "let x: number = 5; let y: number = x > 0 ? x : -x;";
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const conditionalJump = tac.find(
      (inst) => inst.kind === TACInstructionKind.ConditionalJump,
    );
    expect(conditionalJump).toBeDefined();
  });

  it("handles null coalescing expressions", () => {
    const parser = new TypeScriptParser();
    const source =
      'let name: string = "Bob"; let value: string = name ?? "Unknown";';
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const equalityOp = tac.find(
      (inst) =>
        inst.kind === TACInstructionKind.BinaryOp &&
        inst.toString().includes("=="),
    );
    expect(equalityOp).toBeDefined();
  });

  it("handles template expressions", () => {
    const parser = new TypeScriptParser();
    const source = // biome-ignore lint/suspicious/noTemplateCurlyInString: for test
      "let score: number = 5; let msg: string = `Score: ${score}`;";
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
    expect(concatCall).toBeDefined();
  });
});

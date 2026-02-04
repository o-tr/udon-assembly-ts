import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac";
import { TACInstructionKind } from "../../../src/transpiler/ir/tac_instruction";

describe("short-circuit evaluation", () => {
  it("emits short-circuit flow for &&", () => {
    const parser = new TypeScriptParser();
    const source =
      "let a: boolean = true; let b: boolean = false; let c: boolean = a && b;";
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const andLabel = tac.find(
      (inst) =>
        inst.kind === TACInstructionKind.Label &&
        inst.toString().includes("and_short"),
    );
    expect(andLabel).toBeDefined();
  });

  it("emits short-circuit flow for ||", () => {
    const parser = new TypeScriptParser();
    const source =
      "let a: boolean = true; let b: boolean = false; let c: boolean = a || b;";
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const orLabel = tac.find(
      (inst) =>
        inst.kind === TACInstructionKind.Label &&
        inst.toString().includes("or_short"),
    );
    expect(orLabel).toBeDefined();
  });
});

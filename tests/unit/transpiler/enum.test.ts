/**
 * Enum support tests
 */

import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import { TACInstructionKind } from "../../../src/transpiler/ir/tac_instruction";

describe("Enum support", () => {
  it("should register enum values and inline constants", () => {
    const parser = new TypeScriptParser();
    const source = `
      enum TileType { Man, Pin, Sou = 3, Wind }
      let value: number = TileType.Pin;
    `;
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const assignments = tac.filter(
      (inst) => inst.kind === TACInstructionKind.Assignment,
    );
    const hasInline = assignments.some((inst) =>
      inst.toString().includes("= 1"),
    );
    expect(hasInline).toBe(true);
  });

  it("should allow enum values in switch cases", () => {
    const parser = new TypeScriptParser();
    const source = `
      enum TileType { Man = 0, Pin = 1 }
      let v: number = TileType.Man;
      switch (v) {
        case TileType.Man:
          v = TileType.Pin;
          break;
      }
    `;
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const switchLabels = tac.filter(
      (inst) => inst.kind === TACInstructionKind.Label,
    );
    expect(switchLabels.length).toBeGreaterThan(0);
  });
});

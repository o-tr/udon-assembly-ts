/**
 * for...of support tests
 */

import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac";
import { TACInstructionKind } from "../../../src/transpiler/ir/tac_instruction";

describe("for...of", () => {
  it("should lower for...of into array access and loop control", () => {
    const parser = new TypeScriptParser();
    const source = `
      const tiles: number[] = new Array<number>(3);
      for (const tile of tiles) {
        let x: number = tile;
      }
    `;
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const hasArrayAccess = tac.some(
      (inst) => inst.kind === TACInstructionKind.ArrayAccess,
    );
    const hasLabels = tac.some(
      (inst) => inst.kind === TACInstructionKind.Label,
    );

    expect(hasArrayAccess).toBe(true);
    expect(hasLabels).toBe(true);
  });

  it("should support break and continue inside for...of", () => {
    const parser = new TypeScriptParser();
    const source = `
      const tiles: number[] = new Array<number>(2);
      for (const tile of tiles) {
        if (tile > 0) {
          continue;
        }
        break;
      }
    `;
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const jumps = tac.filter(
      (inst) => inst.kind === TACInstructionKind.UnconditionalJump,
    );
    expect(jumps.length).toBeGreaterThan(0);
  });
});

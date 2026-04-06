/**
 * for...of support tests
 */

import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import {
  type MethodCallInstruction,
  TACInstructionKind,
} from "../../../src/transpiler/ir/tac_instruction";

describe("for...of", () => {
  it("should lower for...of into DataList get_Item and loop control", () => {
    const parser = new TypeScriptParser();
    const source = `
      const tiles: number[] = [1, 2, 3];
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

    // for...of uses DataList get_Item (MethodCall) for element access
    const hasGetItem = tac.some(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        (inst as MethodCallInstruction).method === "get_Item",
    );
    const hasLabels = tac.some(
      (inst) => inst.kind === TACInstructionKind.Label,
    );

    expect(hasGetItem).toBe(true);
    expect(hasLabels).toBe(true);
  });

  it("should support break and continue inside for...of", () => {
    const parser = new TypeScriptParser();
    const source = `
      const tiles: number[] = [1, 2];
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

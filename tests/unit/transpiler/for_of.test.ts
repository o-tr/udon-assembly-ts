/**
 * for...of support tests
 */

import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import {
  type MethodCallInstruction,
  TACInstructionKind,
} from "../../../src/transpiler/ir/tac_instruction";

describe("for...of", () => {
  it("should lower for...of over a native array using ArrayAccess and loop control", () => {
    const parser = new TypeScriptParser();
    // number[] with a constant-length literal → native array (SystemSingleArray).
    // for...of uses ArrayAccess (not DataList get_Item).
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

    // Native for...of uses ArrayAccess, not DataList get_Item.
    const hasArrayAccess = tac.some(
      (inst) => inst.kind === TACInstructionKind.ArrayAccess,
    );
    const hasLabels = tac.some(
      (inst) => inst.kind === TACInstructionKind.Label,
    );
    const hasGetItem = tac.some(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        (inst as MethodCallInstruction).method === "get_Item",
    );

    expect(hasArrayAccess).toBe(true);
    expect(hasLabels).toBe(true);
    expect(hasGetItem).toBe(false);
  });

  it("should lower for...of over a DataList array using get_Item and loop control", () => {
    const parser = new TypeScriptParser();
    // Passing the array to a function marks it ineligible → stays as DataList.
    const source = `
      function consume(arr: number[]): void {}
      const tiles: number[] = [1, 2, 3];
      consume(tiles);
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

    // DataList for...of uses MethodCall with get_Item.
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

  it("lowers DataDictionary destructuring through keys and value lookups", () => {
    const source = `
      import { DataDictionary, DataToken } from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const dict: DataDictionary = new DataDictionary();
          dict.SetValue(new DataToken("x"), new DataToken(10));
          let count: number = 0;
          let sum: number = 0;
          for (const [_key, value] of dict) {
            count = count + 1;
            sum = sum + value.Double;
          }
          Debug.Log(count);
          Debug.Log(sum);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });

    expect(result.tac).toContain("GetKeys");
    expect(result.tac).toContain("GetValue");
    expect(result.uasm).toMatch(
      /VRCSDK3DataDataDictionary\.__GetKeys__VRCSDK3DataDataList/,
    );
    expect(result.uasm).toMatch(
      /VRCSDK3DataDataDictionary\.__get_Item__VRCSDK3DataDataToken__VRCSDK3DataDataToken/,
    );
    expect(result.uasm).not.toContain("structural dispatch miss");
  });
});

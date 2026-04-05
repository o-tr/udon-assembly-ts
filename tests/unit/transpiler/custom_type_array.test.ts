/**
 * Tests that custom type arrays (e.g. Tile[], Meld[]) emit
 * SystemObjectArray externs instead of invalid TileArray / MeldArray externs.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon/index.js";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";

describe("custom type array operations", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("emits SystemObjectArray externs for custom type array .length", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Tile {
        id: number = 0;
      }
      class Demo {
        Start(): void {
          const tiles: Tile[] = [];
          let len: number = tiles.length;
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

    // Should use SystemObjectArray, NOT TileArray
    expect(
      externs.some((sig) => sig.includes("SystemObjectArray.__get_length__")),
    ).toBe(true);
    expect(externs.some((sig) => sig.includes("TileArray"))).toBe(false);
  });

  it("emits SystemObjectArray externs for custom type array .push()", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Meld {
        value: number = 0;
      }
      class Demo {
        Start(): void {
          let melds: Meld[] = [];
          const m: Meld = new Meld();
          melds.push(m);
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

    // Should NOT have any MeldArray externs
    expect(externs.some((sig) => sig.includes("MeldArray"))).toBe(false);
    // Should use SystemObjectArray for the push-equivalent operation
    expect(externs.some((sig) => sig.includes("SystemObjectArray"))).toBe(true);
  });

  it("generates valid length extern for known type arrays (number[], string[])", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          const nums: number[] = [];
          let len: number = nums.length;
          const strs: string[] = [];
          let slen: number = strs.length;
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

    // Array .length should use a valid Udon extern (DataList.Count or typed length)
    expect(
      externs.some(
        (sig) =>
          sig.includes("get_Length__SystemInt32") ||
          sig.includes("get_length__SystemInt32") ||
          sig.includes("get_Count__SystemInt32"),
      ),
    ).toBe(true);
    // Should NOT produce invalid unresolvable externs
    expect(
      externs.some((sig) => sig.includes("__get_length__SystemObject")),
    ).toBe(false);
  });

  it("generates valid length extern for Unity type arrays (Vector3[], Transform[])", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          const vecs: Vector3[] = [];
          let vlen: number = vecs.length;
          const transforms: Transform[] = [];
          let tlen: number = transforms.length;
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

    // Array .length should use a valid Udon extern
    expect(
      externs.some(
        (sig) =>
          sig.includes("get_Length__SystemInt32") ||
          sig.includes("get_length__SystemInt32") ||
          sig.includes("get_Count__SystemInt32"),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) => sig.includes("__get_length__SystemObject")),
    ).toBe(false);
  });

  it("handles type alias arrays correctly", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Meld {
        value: number = 0;
      }
      type MeldAlias = Meld;
      type NumAlias = number;
      class Demo {
        Start(): void {
          const melds: MeldAlias[] = [];
          let mlen: number = melds.length;
          const nums: NumAlias[] = [];
          let nlen: number = nums.length;
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

    // Custom class alias array should fallback to SystemObjectArray
    expect(
      externs.some((sig) => sig.includes("SystemObjectArray.__get_length__")),
    ).toBe(true);
    expect(externs.some((sig) => sig.includes("MeldArray"))).toBe(false);
    expect(externs.some((sig) => sig.includes("MeldAliasArray"))).toBe(false);
    // Known type alias array should use a valid length extern
    expect(
      externs.some(
        (sig) =>
          sig.includes("get_Length__SystemInt32") ||
          sig.includes("get_length__SystemInt32") ||
          sig.includes("get_Count__SystemInt32"),
      ),
    ).toBe(true);
  });

  it("emits typed SystemObjectArray Get/Set for custom type array indexing", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Tile {
        code: number = 0;
      }
      class Demo {
        Start(): void {
          const tiles: Tile[] = [];
          let t = tiles[0];
          tiles[1] = t;
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

    // Custom type array indexing should use SystemObjectArray (not SystemArray)
    expect(
      externs.some((sig) =>
        sig.includes("SystemObjectArray.__Get__SystemInt32__SystemObject"),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "SystemObjectArray.__Set__SystemInt32_SystemObject__SystemVoid",
        ),
      ),
    ).toBe(true);
    // Base class SystemArray.__Get__/__Set__ should NOT appear
    expect(
      externs.some((sig) => sig.includes("SystemArray.__Get__")),
    ).toBe(false);
    expect(
      externs.some((sig) => sig.includes("SystemArray.__Set__")),
    ).toBe(false);
  });
});

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
  });

  it("preserves correct externs for known type arrays (number[], string[])", () => {
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

    // Known type arrays should keep their specific type names
    expect(
      externs.some((sig) =>
        sig.includes("SystemSingleArray.__get_length__SystemInt32"),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes("SystemStringArray.__get_length__SystemInt32"),
      ),
    ).toBe(true);
    // Should NOT fallback to SystemObjectArray for known types
    expect(
      externs.some((sig) => sig.includes("SystemObjectArray.__get_length__")),
    ).toBe(false);
  });

  it("preserves correct externs for Unity type arrays (Vector3[], Transform[])", () => {
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

    // Unity type arrays should keep their specific type names
    expect(
      externs.some((sig) =>
        sig.includes("UnityEngineVector3Array.__get_length__SystemInt32"),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes("UnityEngineTransformArray.__get_length__SystemInt32"),
      ),
    ).toBe(true);
    // Should NOT fallback to SystemObjectArray for Unity types
    expect(
      externs.some((sig) => sig.includes("SystemObjectArray.__get_length__")),
    ).toBe(false);
  });
});

/**
 * Tests that custom type arrays (e.g. Tile[], Meld[]) emit
 * DataList externs instead of invalid TileArray / MeldArray externs.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon/index.js";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { PrimitiveTypes } from "../../../src/transpiler/frontend/type_symbols";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import {
  type MethodCallInstruction,
  TACInstructionKind,
} from "../../../src/transpiler/ir/tac_instruction";

describe("custom type array operations", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("emits DataList Count extern for custom type array .length", () => {
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

    // Arrays now use DataList.Count instead of SystemObjectArray.get_Length
    expect(
      externs.some((sig) =>
        sig.includes("VRCSDK3DataDataList.__get_Count__SystemInt32"),
      ),
    ).toBe(true);
    expect(externs.some((sig) => sig.includes("TileArray"))).toBe(false);
    expect(
      externs.some((sig) => sig.includes("SystemObjectArray.__get_Length__")),
    ).toBe(false);
  });

  it("emits DataList Add + DataToken externs for custom type array .push()", () => {
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
    // Should NOT use SystemObjectArray (now uses DataList)
    expect(externs.some((sig) => sig.includes("SystemObjectArray"))).toBe(
      false,
    );
    // Should use DataList.Add for the push operation
    expect(
      externs.some((sig) =>
        sig.includes(
          "VRCSDK3DataDataList.__Add__VRCSDK3DataDataToken__SystemVoid",
        ),
      ),
    ).toBe(true);
    // Should use DataToken constructor for wrapping
    expect(
      externs.some((sig) => sig.includes("VRCSDK3DataDataToken.__ctor__")),
    ).toBe(true);
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

    // All arrays now use DataList.Count instead of SystemObjectArray.get_Length
    expect(
      externs.some((sig) =>
        sig.includes("VRCSDK3DataDataList.__get_Count__SystemInt32"),
      ),
    ).toBe(true);
    expect(externs.some((sig) => sig.includes("MeldArray"))).toBe(false);
    expect(externs.some((sig) => sig.includes("MeldAliasArray"))).toBe(false);
    expect(
      externs.some((sig) => sig.includes("SystemObjectArray.__get_Length__")),
    ).toBe(false);
  });

  it("coerces array.length assignment count to Int32 for GetRange", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          const nums: number[] = [1, 2, 3];
          const f: UdonFloat = 1.5 as UdonFloat;
          nums.length = f;
        }
      }
    `;
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const getRangeCalls = tac.filter(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        (inst as MethodCallInstruction).method === "GetRange",
    ) as MethodCallInstruction[];
    expect(getRangeCalls.length).toBeGreaterThan(0);
    for (const call of getRangeCalls) {
      const [start, count] = call.args;
      expect("type" in start && start.type === PrimitiveTypes.int32).toBe(true);
      expect("type" in count && count.type === PrimitiveTypes.int32).toBe(true);
    }
    expect(tac.some((inst) => inst.kind === TACInstructionKind.Cast)).toBe(
      true,
    );
  });

  it("coerces slice(start, end) arguments to Int32 for GetRange", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          const nums: number[] = [1, 2, 3];
          const start: UdonFloat = 1.5 as UdonFloat;
          const end: UdonFloat = 2.5 as UdonFloat;
          const sliced = nums.slice(start, end);
        }
      }
    `;
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const getRangeCalls = tac.filter(
      (inst) =>
        inst.kind === TACInstructionKind.MethodCall &&
        (inst as MethodCallInstruction).method === "GetRange",
    ) as MethodCallInstruction[];
    expect(getRangeCalls.length).toBeGreaterThan(0);
    for (const call of getRangeCalls) {
      const [start, count] = call.args;
      expect("type" in start && start.type === PrimitiveTypes.int32).toBe(true);
      expect("type" in count && count.type === PrimitiveTypes.int32).toBe(true);
    }
    expect(tac.some((inst) => inst.kind === TACInstructionKind.Cast)).toBe(
      true,
    );
  });

  it("emits DataList get_Item/set_Item + DataToken for custom type array indexing", () => {
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

    // Custom type array indexing now uses DataList get_Item/set_Item + DataToken
    expect(
      externs.some((sig) =>
        sig.includes(
          "VRCSDK3DataDataList.__get_Item__SystemInt32__VRCSDK3DataDataToken",
        ),
      ),
    ).toBe(true);
    expect(
      externs.some((sig) =>
        sig.includes(
          "VRCSDK3DataDataList.__set_Item__SystemInt32_VRCSDK3DataDataToken__SystemVoid",
        ),
      ),
    ).toBe(true);
    // Old SystemObjectArray/SystemArray Get/Set should NOT appear
    expect(
      externs.some((sig) => sig.includes("SystemObjectArray.__Get__")),
    ).toBe(false);
    expect(
      externs.some((sig) => sig.includes("SystemObjectArray.__Set__")),
    ).toBe(false);
    expect(externs.some((sig) => sig.includes("SystemArray.__Get__"))).toBe(
      false,
    );
    expect(externs.some((sig) => sig.includes("SystemArray.__Set__"))).toBe(
      false,
    );
  });
});

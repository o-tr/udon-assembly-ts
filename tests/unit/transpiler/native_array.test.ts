/**
 * Native array optimization tests.
 *
 * Arrays with known compile-time length (literal initializers, or new Array<T>(N))
 * that don't use dynamic operations are lowered to native Udon typed arrays
 * (e.g. SystemSingleArray) instead of DataList, reducing instruction count.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon/index.js";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import { TACInstructionKind } from "../../../src/transpiler/ir/tac_instruction";

function compileToExterns(source: string): string[] {
  const parser = new TypeScriptParser();
  const ast = parser.parse(source);
  const tacConverter = new ASTToTACConverter(
    parser.getSymbolTable(),
    parser.getEnumRegistry(),
  );
  const tac = tacConverter.convert(ast);
  const udonConverter = new TACToUdonConverter();
  udonConverter.convert(tac);
  return udonConverter.getExternSignatures();
}

function compileToTAC(source: string) {
  const parser = new TypeScriptParser();
  const ast = parser.parse(source);
  const converter = new ASTToTACConverter(
    parser.getSymbolTable(),
    parser.getEnumRegistry(),
  );
  return converter.convert(ast);
}

describe("native array optimization", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  describe("array literal → SystemSingleArray (number[])", () => {
    it("emits native ctor and no DataToken on array literal", () => {
      const externs = compileToExterns(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
          }
        }
      `);
      // Native ctor must be present
      expect(
        externs.some((s) =>
          s.includes("SystemSingleArray.__ctor__SystemInt32__SystemSingleArray"),
        ),
      ).toBe(true);
      // Native set must be present for each element
      expect(
        externs.some((s) =>
          s.includes(
            "SystemSingleArray.__Set__SystemInt32_SystemSingle__SystemVoid",
          ),
        ),
      ).toBe(true);
      // No DataList or DataToken externs should appear for this array
      expect(
        externs.some((s) => s.includes("VRCSDK3DataDataToken.__ctor__")),
      ).toBe(false);
      expect(
        externs.some((s) =>
          s.includes("VRCSDK3DataDataList.__Add__"),
        ),
      ).toBe(false);
    });

    it("emits native Get for element read", () => {
      const externs = compileToExterns(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
            const x: number = arr[0];
          }
        }
      `);
      expect(
        externs.some((s) =>
          s.includes("SystemSingleArray.__Get__SystemInt32__SystemSingle"),
        ),
      ).toBe(true);
      // No DataToken unwrap
      expect(
        externs.some((s) => s.includes("DataToken")),
      ).toBe(false);
    });

    it("emits native Set for element write", () => {
      const externs = compileToExterns(`
        class Demo {
          Start(): void {
            let arr: number[] = [1, 2, 3];
            arr[1] = 5;
          }
        }
      `);
      expect(
        externs.some((s) =>
          s.includes(
            "SystemSingleArray.__Set__SystemInt32_SystemSingle__SystemVoid",
          ),
        ),
      ).toBe(true);
      expect(
        externs.some((s) => s.includes("DataToken")),
      ).toBe(false);
    });

    it("emits native Get+Set for compound assignment arr[i] += v", () => {
      const externs = compileToExterns(`
        class Demo {
          Start(): void {
            let arr: number[] = [1, 2, 3];
            arr[0] += 10;
          }
        }
      `);
      expect(
        externs.some((s) =>
          s.includes("SystemSingleArray.__Get__SystemInt32__SystemSingle"),
        ),
      ).toBe(true);
      expect(
        externs.some((s) =>
          s.includes(
            "SystemSingleArray.__Set__SystemInt32_SystemSingle__SystemVoid",
          ),
        ),
      ).toBe(true);
    });

    it("emits native get_Length for .length property", () => {
      const externs = compileToExterns(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
            const len: number = arr.length;
          }
        }
      `);
      expect(
        externs.some((s) =>
          s.includes("SystemSingleArray.__get_Length__SystemInt32"),
        ),
      ).toBe(true);
      // No DataList Count
      expect(
        externs.some((s) => s.includes("__get_Count__")),
      ).toBe(false);
    });

    it("emits native get_Length and Get in for...of loop", () => {
      const externs = compileToExterns(`
        class Demo {
          Start(): void {
            const arr: number[] = [10, 20, 30];
            let sum: number = 0;
            for (const x of arr) {
              sum = sum + x;
            }
          }
        }
      `);
      expect(
        externs.some((s) =>
          s.includes("SystemSingleArray.__get_Length__SystemInt32"),
        ),
      ).toBe(true);
      expect(
        externs.some((s) =>
          s.includes("SystemSingleArray.__Get__SystemInt32__SystemSingle"),
        ),
      ).toBe(true);
      // No DataList get_Item
      expect(
        externs.some((s) => s.includes("__get_Item__")),
      ).toBe(false);
    });
  });

  describe("boolean[] and string[] → native arrays", () => {
    it("uses SystemBooleanArray for boolean[]", () => {
      const externs = compileToExterns(`
        class Demo {
          Start(): void {
            const flags: boolean[] = [true, false, true];
            const f: boolean = flags[0];
          }
        }
      `);
      expect(
        externs.some((s) =>
          s.includes("SystemBooleanArray.__ctor__SystemInt32__SystemBooleanArray"),
        ),
      ).toBe(true);
      expect(
        externs.some((s) =>
          s.includes("SystemBooleanArray.__Get__SystemInt32__SystemBoolean"),
        ),
      ).toBe(true);
    });

    it("uses SystemStringArray for string[]", () => {
      const externs = compileToExterns(`
        class Demo {
          Start(): void {
            const words: string[] = ["a", "b"];
            const w: string = words[0];
          }
        }
      `);
      expect(
        externs.some((s) =>
          s.includes("SystemStringArray.__ctor__SystemInt32__SystemStringArray"),
        ),
      ).toBe(true);
      expect(
        externs.some((s) =>
          s.includes("SystemStringArray.__Get__SystemInt32__SystemString"),
        ),
      ).toBe(true);
    });
  });

  describe("ineligibility fallback → DataList", () => {
    it("falls back to DataList when .push() is used", () => {
      const externs = compileToExterns(`
        class Demo {
          Start(): void {
            let arr: number[] = [1, 2, 3];
            arr.push(4);
          }
        }
      `);
      // Must use DataList (not native) because push is called
      expect(
        externs.some((s) => s.includes("VRCSDK3DataDataList")),
      ).toBe(true);
      expect(
        externs.some((s) => s.includes("SystemSingleArray.__ctor__")),
      ).toBe(false);
    });

    it("falls back to DataList when array is passed to a function", () => {
      const externs = compileToExterns(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
            this.consume(arr);
          }
          consume(arr: number[]): void {}
        }
      `);
      expect(
        externs.some((s) => s.includes("VRCSDK3DataDataList")),
      ).toBe(true);
      expect(
        externs.some((s) => s.includes("SystemSingleArray.__ctor__")),
      ).toBe(false);
    });

    it("falls back to DataList for empty array []", () => {
      const tac = compileToTAC(`
        class Demo {
          Start(): void {
            const arr: number[] = [];
          }
        }
      `);
      // No ArrayAccess or ArrayAssignment for an empty array
      expect(
        tac.some((inst) => inst.kind === TACInstructionKind.ArrayAccess),
      ).toBe(false);
      // DataList ctor should still appear (or at minimum no native array ctor)
      const externs = (() => {
        const parser = new TypeScriptParser();
        const ast = parser.parse(`
          class Demo {
            Start(): void {
              const arr: number[] = [];
            }
          }
        `);
        const converter = new ASTToTACConverter(
          parser.getSymbolTable(),
          parser.getEnumRegistry(),
        );
        const tac2 = converter.convert(ast);
        const udon = new TACToUdonConverter();
        udon.convert(tac2);
        return udon.getExternSignatures();
      })();
      expect(
        externs.some((s) => s.includes("SystemSingleArray.__ctor__")),
      ).toBe(false);
    });

    it("falls back to DataList for custom class array", () => {
      const externs = compileToExterns(`
        class Tile {
          code: number = 0;
        }
        class Demo {
          Start(): void {
            const tiles: Tile[] = [];
            const t: Tile = tiles[0];
          }
        }
      `);
      // Custom class element type has no native Udon array mapping
      expect(
        externs.some((s) => s.includes("VRCSDK3DataDataList")),
      ).toBe(true);
      expect(
        externs.every((s) => !s.includes("SystemTileArray")),
      ).toBe(true);
    });

    it("falls back when .slice() is used (DataList method)", () => {
      const externs = compileToExterns(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
            const sliced: number[] = arr.slice(0, 2);
          }
        }
      `);
      expect(
        externs.some((s) => s.includes("VRCSDK3DataDataList")),
      ).toBe(true);
      expect(
        externs.some((s) => s.includes("SystemSingleArray.__ctor__")),
      ).toBe(false);
    });
  });

  describe("mixed eligibility", () => {
    it("native array and DataList can coexist in the same method", () => {
      const externs = compileToExterns(`
        class Demo {
          Start(): void {
            // This stays native (no dynamic ops)
            const fixed: number[] = [1, 2, 3];
            const x: number = fixed[0];
            // This falls back to DataList due to push
            let dynamic: number[] = [4, 5, 6];
            dynamic.push(7);
          }
        }
      `);
      // Native externs from 'fixed'
      expect(
        externs.some((s) =>
          s.includes("SystemSingleArray.__Get__SystemInt32__SystemSingle"),
        ),
      ).toBe(true);
      // DataList externs from 'dynamic'
      expect(
        externs.some((s) => s.includes("VRCSDK3DataDataList")),
      ).toBe(true);
    });
  });
});

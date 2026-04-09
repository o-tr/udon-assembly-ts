/**
 * Native array optimization tests.
 *
 * Arrays with known compile-time length (literal initializers, or new Array<T>(N))
 * that don't use dynamic operations are lowered to native Udon typed arrays
 * (e.g. SystemSingleArray) instead of DataList, reducing instruction count.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

function transpile(source: string) {
  return new TypeScriptToUdonTranspiler().transpile(source);
}

describe("native array optimization", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  describe("array literal → SystemSingleArray (number[])", () => {
    it("emits native ctor and no DataToken on array literal", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
          }
        }
      `);
      // Native ctor must be present
      expect(uasm).toContain(
        "SystemSingleArray.__ctor__SystemInt32__SystemSingleArray",
      );
      // Native set must be present for each element
      expect(uasm).toContain(
        "SystemSingleArray.__Set__SystemInt32_SystemSingle__SystemVoid",
      );
      // No DataList or DataToken externs should appear for this array
      expect(uasm).not.toContain("VRCSDK3DataDataToken.__ctor__");
      expect(uasm).not.toContain("VRCSDK3DataDataList.__Add__");
    });

    it("emits native Get for element read", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
            const x: number = arr[0];
          }
        }
      `);
      expect(uasm).toContain(
        "SystemSingleArray.__Get__SystemInt32__SystemSingle",
      );
      // No DataToken unwrap
      expect(uasm).not.toContain("DataToken");
    });

    it("emits native Set for element write", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            let arr: number[] = [1, 2, 3];
            arr[1] = 5;
          }
        }
      `);
      expect(uasm).toContain(
        "SystemSingleArray.__Set__SystemInt32_SystemSingle__SystemVoid",
      );
      expect(uasm).not.toContain("DataToken");
    });

    it("emits native Get+Set for compound assignment arr[i] += v", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            let arr: number[] = [1, 2, 3];
            arr[0] += 10;
          }
        }
      `);
      expect(uasm).toContain(
        "SystemSingleArray.__Get__SystemInt32__SystemSingle",
      );
      expect(uasm).toContain(
        "SystemSingleArray.__Set__SystemInt32_SystemSingle__SystemVoid",
      );
    });

    it("emits native get_Length for .length property", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
            const len: number = arr.length;
          }
        }
      `);
      expect(uasm).toContain("SystemSingleArray.__get_Length__SystemInt32");
      // No DataList Count
      expect(uasm).not.toContain("__get_Count__");
    });

    it("emits native get_Length and Get in for...of loop", () => {
      const { uasm } = transpile(`
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
      expect(uasm).toContain("SystemSingleArray.__get_Length__SystemInt32");
      expect(uasm).toContain(
        "SystemSingleArray.__Get__SystemInt32__SystemSingle",
      );
      // No DataList get_Item
      expect(uasm).not.toContain("__get_Item__");
    });

    it("native for...of with continue correctly increments the index", () => {
      // Regression: continueLabel must point to the increment, not loopStart.
      // If continue jumps to loopStart (before increment), the loop hangs forever.
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = [10, 20, 30];
            let sum: number = 0;
            for (const x of arr) {
              if (x === 20) {
                continue;
              }
              sum = sum + x;
            }
          }
        }
      `);
      // Must use native externs (not DataList get_Item)
      expect(uasm).toContain("SystemSingleArray.__get_Length__SystemInt32");
      expect(uasm).toContain(
        "SystemSingleArray.__Get__SystemInt32__SystemSingle",
      );
      expect(uasm).not.toContain("__get_Item__");
      // The forof_native_continue label must appear in the assembled output
      // so the continue instruction has a valid target past the loop body.
      expect(uasm).toContain("forof_native_continue");
    });
  });

  describe("new Array<T>(N) → native array", () => {
    it("new Array<number>(3) emits native ctor without element init", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = new Array<number>(3);
            const x: number = arr[0];
          }
        }
      `);
      expect(uasm).toContain(
        "SystemSingleArray.__ctor__SystemInt32__SystemSingleArray",
      );
      expect(uasm).toContain(
        "SystemSingleArray.__Get__SystemInt32__SystemSingle",
      );
      // No per-element Set calls (ctor zero-initializes)
      expect(uasm).not.toContain("VRCSDK3DataDataList");
      expect(uasm).not.toContain("DataToken");
    });

    it("new Array<number>(0) falls back to DataList (zero-length)", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = new Array<number>(0);
          }
        }
      `);
      // Zero-length native arrays are not useful; stay as DataList
      expect(uasm).toContain("VRCSDK3DataDataList");
      expect(uasm).not.toContain("SystemSingleArray.__ctor__");
    });

    it("new Array<number>(N) falls back to DataList for runtime N", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const n: number = 3;
            const arr: number[] = new Array<number>(n);
          }
        }
      `);
      // Runtime-length array cannot be statically sized → DataList
      expect(uasm).toContain("VRCSDK3DataDataList");
      expect(uasm).not.toContain("SystemSingleArray.__ctor__");
    });
  });

  describe("boolean[] and string[] → native arrays", () => {
    it("uses SystemBooleanArray for boolean[]", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const flags: boolean[] = [true, false, true];
            const f: boolean = flags[0];
          }
        }
      `);
      expect(uasm).toContain(
        "SystemBooleanArray.__ctor__SystemInt32__SystemBooleanArray",
      );
      expect(uasm).toContain(
        "SystemBooleanArray.__Get__SystemInt32__SystemBoolean",
      );
    });

    it("uses SystemStringArray for string[]", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const words: string[] = ["a", "b"];
            const w: string = words[0];
          }
        }
      `);
      expect(uasm).toContain(
        "SystemStringArray.__ctor__SystemInt32__SystemStringArray",
      );
      expect(uasm).toContain(
        "SystemStringArray.__Get__SystemInt32__SystemString",
      );
    });
  });

  describe("ineligibility fallback → DataList", () => {
    it("falls back to DataList when .push() is used", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            let arr: number[] = [1, 2, 3];
            arr.push(4);
          }
        }
      `);
      // Must use DataList (not native) because push is called
      expect(uasm).toContain("VRCSDK3DataDataList");
      expect(uasm).not.toContain("SystemSingleArray.__ctor__");
    });

    it("falls back to DataList when array is passed to a function", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
            this.consume(arr);
          }
          consume(arr: number[]): void {}
        }
      `);
      expect(uasm).toContain("VRCSDK3DataDataList");
      expect(uasm).not.toContain("SystemSingleArray.__ctor__");
    });

    it("falls back to DataList for empty array []", () => {
      const { tac } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = [];
          }
        }
      `);
      // No ArrayAccess or ArrayAssignment for an empty array
      expect(tac.split("\n").some((line) => line.includes("ArrayAccess"))).toBe(
        false,
      );
      // No native ctor in UASM
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = [];
          }
        }
      `);
      expect(uasm).not.toContain("SystemSingleArray.__ctor__");
    });

    it("falls back to DataList for custom class array", () => {
      const { uasm } = transpile(`
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
      expect(uasm).toContain("VRCSDK3DataDataList");
      expect(uasm).not.toContain("SystemTileArray");
    });

    it("falls back when .slice() is used (DataList method)", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
            const sliced: number[] = arr.slice(0, 2);
          }
        }
      `);
      expect(uasm).toContain("VRCSDK3DataDataList");
      expect(uasm).not.toContain("SystemSingleArray.__ctor__");
    });
  });

  describe("mixed eligibility", () => {
    it("native array and DataList can coexist in the same method", () => {
      const { uasm } = transpile(`
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
      expect(uasm).toContain(
        "SystemSingleArray.__Get__SystemInt32__SystemSingle",
      );
      // DataList externs from 'dynamic'
      expect(uasm).toContain("VRCSDK3DataDataList");
    });
  });

  describe("alias propagation", () => {
    it("alias with dynamic op falls back to DataList for both variables", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
            const b = arr;
            b.push(4);
          }
        }
      `);
      // Both arr and b share the same object; b.push makes b ineligible.
      // The alias (const b = arr) must also make arr ineligible.
      expect(uasm).toContain("VRCSDK3DataDataList");
      expect(uasm).not.toContain("SystemSingleArray.__ctor__");
    });

    it("alias passed to function falls back to DataList for both variables", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
            const b = arr;
            this.consume(b);
          }
          consume(x: number[]): void {}
        }
      `);
      expect(uasm).toContain("VRCSDK3DataDataList");
      expect(uasm).not.toContain("SystemSingleArray.__ctor__");
    });
  });

  describe("Int32 constant values in UASM data section", () => {
    it("emits bare integer (not quoted) for native array length constant", () => {
      const { uasm } = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
          }
        }
      `);
      // The heap declaration for length/index constants must be unquoted integers.
      // A quoted string like `"3"` is invalid UASM and would fail to load in VRChat.
      expect(uasm).toContain("%SystemInt32, 3");
      expect(uasm).toContain("%SystemInt32, 0");
      expect(uasm).toContain("%SystemInt32, 1");
      expect(uasm).toContain("%SystemInt32, 2");
      // No string-wrapped integers like `"\"3\""` in the data section
      expect(uasm).not.toMatch(/%SystemInt32,\s*""\d+""/);
    });
  });

  describe("TAC-level checks", () => {
    it("emits array index access notation for native array read", () => {
      const result = transpile(`
        class Demo {
          Start(): void {
            const arr: number[] = [1, 2, 3];
            const x: number = arr[0];
          }
        }
      `);
      // TAC renders ArrayAccess as arr[idx] notation
      expect(result.tac).toMatch(/arr\[/);
      expect(result.tac).not.toContain("get_Item");
    });
  });
});

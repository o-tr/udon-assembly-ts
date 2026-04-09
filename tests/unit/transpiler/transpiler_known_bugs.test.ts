/**
 * Regression tests for known transpiler bugs discovered during VM testing.
 *
 * Bug 1 (FIXED): String.slice() negative index — resolved by replacing
 *         compile-time isNegConst() with a runtime branch in resolveIndex().
 *         (root cause #12 in vm-test-failures-investigation.md)
 *
 * Bug 2 (FIXED for CollectionTypeSymbol): DataToken.get_Reference misselection —
 *         CollectionTypeSymbol hardcodes UdonType.Object, causing DataList/
 *         DataDictionary DataTokens to unwrap with .Reference instead of
 *         .DataList/.DataDictionary. SoA inline fields still affected.
 *         (root cause #11 in vm-test-failures-investigation.md)
 *
 * Bug 3 (FIXED): ArrayTypeSymbol data section type mismatch — the data section
 *         declares array-typed variables as %SystemArray but EXTERN signatures
 *         use VRCSDK3DataDataList.
 *         (root cause #13 in vm-test-failures-investigation.md)
 *
 * Bug 4: SoA inline field DataToken unwrap — when an inline class field holds a
 *         DataDictionary/DataList (e.g. Map<K,V>), the SoA field type resolves as
 *         ClassTypeSymbol (udonType="Object") instead of preserving the collection
 *         type, causing unwrapDataToken to use .Reference.
 *         (root cause #11 continuation in vm-test-failures-investigation.md)
 *
 * Bug 5: String boolean coercion — `!str` on a string variable generates
 *         SystemConvert.ToBoolean(string) which throws at runtime for any value
 *         other than "True"/"False". JS truthy semantics require non-empty check.
 *         (root cause #15 in vm-test-failures-investigation.md)
 *
 * Bug 6: Array index assignment on empty DataList — `arr[i] = value` in a loop
 *         generates DataList.set_Item but the DataList was never pre-populated,
 *         causing an IndexOutOfRange at runtime.
 *         (root cause #13 continuation in vm-test-failures-investigation.md)
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("known transpiler bugs", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  // ---------------------------------------------------------------------------
  // Bug 1: String.slice() negative index
  // ---------------------------------------------------------------------------

  describe("string slice negative index", () => {
    it("positive-index slice works correctly (baseline)", () => {
      const source = `
        class Main {
          Start(): void {
            const s: string = "Hello World";
            const r: string = s.slice(0, 5);
            Debug.Log(r);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // Positive indices should produce a Substring call
      expect(result.uasm).toContain("__Substring__");
      // Fast-path: no runtime get_Length branch for known non-negative constants
      expect(result.uasm).not.toContain("__get_Length__");
    });

    it("slice(0, -1) should emit Length-adjusted endIndex", () => {
      const source = `
          class Main {
            Start(): void {
              const s: string = "Hello World";
              const r: string = s.slice(0, -1);
              Debug.Log(r);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // After fix: must call get_Length to adjust the negative index
      expect(result.uasm).toContain("__get_Length__");

      // Should contain Addition for length + (-1) adjustment
      expect(result.uasm).toContain(
        "SystemInt32.__op_Addition__SystemInt32_SystemInt32__SystemInt32",
      );
    });

    it("slice(-2) should emit Length-adjusted startIndex", () => {
      const source = `
          class Main {
            Start(): void {
              const s: string = "Hello World";
              const r: string = s.slice(-2);
              Debug.Log(r);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // After fix: must call get_Length to adjust the negative start index
      expect(result.uasm).toContain("__get_Length__");

      // Should contain Addition for length + (-2) adjustment
      expect(result.uasm).toContain(
        "SystemInt32.__op_Addition__SystemInt32_SystemInt32__SystemInt32",
      );
    });

    it("slice(-999) should clamp over-negative index to 0", () => {
      const source = `
          class Main {
            Start(): void {
              const s: string = "Hi";
              const r: string = s.slice(-999);
              Debug.Log(r);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // Must adjust via get_Length + Addition
      expect(result.uasm).toContain("__get_Length__");
      expect(result.uasm).toContain(
        "SystemInt32.__op_Addition__SystemInt32_SystemInt32__SystemInt32",
      );

      // Must clamp via LessThan comparison against 0
      expect(result.uasm).toContain(
        "SystemInt32.__op_LessThan__SystemInt32_SystemInt32__SystemBoolean",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 2: DataToken.get_Reference misselection
  // ---------------------------------------------------------------------------

  describe("DataToken unwrap for collection types", () => {
    const mapFieldSource = `
      class Entry {
        public data: Map<string, string>;
        constructor(data: Map<string, string>) {
          this.data = data;
        }
      }
      class Main {
        Start(): void {
          const entries: Entry[] = [];
          for (let i: number = 0; i < 2; i++) {
            const m: Map<string, string> = new Map<string, string>();
            m.set("key", "value");
            entries.push(new Entry(m));
          }
          const d = entries[0].data;
          Debug.Log(d.get("key"));
        }
      }
    `;

    it("Map field in loop-created inline class should unwrap via DataDictionary, not Reference", () => {
      const result = new TypeScriptToUdonTranspiler().transpile(mapFieldSource);

      expect(result.uasm).not.toContain(
        "DataToken.__get_Reference__SystemObject",
      );
      expect(result.uasm).toContain(
        "VRCSDK3DataDataToken.__get_DataDictionary__VRCSDK3DataDataDictionary",
      );
    });

    const setFieldSource = `
      class Entry {
        public data: Set<string>;
        constructor(data: Set<string>) {
          this.data = data;
        }
      }
      class Main {
        Start(): void {
          const entries: Entry[] = [];
          for (let i: number = 0; i < 2; i++) {
            const s: Set<string> = new Set<string>();
            s.add("value");
            entries.push(new Entry(s));
          }
          const d = entries[0].data;
          Debug.Log(d.has("value"));
        }
      }
    `;

    it("Set field in loop-created inline class should unwrap via DataDictionary, not Reference", () => {
      const result = new TypeScriptToUdonTranspiler().transpile(setFieldSource);

      expect(result.uasm).not.toContain(
        "DataToken.__get_Reference__SystemObject",
      );
      expect(result.uasm).toContain(
        "VRCSDK3DataDataToken.__get_DataDictionary__VRCSDK3DataDataDictionary",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 3: ArrayTypeSymbol data section type mismatch
  // ---------------------------------------------------------------------------

  describe("array type data section declaration", () => {
    /** Extract data section lines from UASM (lines between .data_start and .data_end) */
    function getDataSection(uasm: string): string[] {
      const lines = uasm.split("\n");
      const startIdx = lines.findIndex((l) => l.includes(".data_start"));
      const endIdx = lines.findIndex((l) => l.includes(".data_end"));
      if (startIdx < 0 || endIdx < 0) return [];
      return lines.slice(startIdx, endIdx + 1);
    }

    it("number[] variable should not declare as %SystemArray in data section", () => {
      const source = `
          class Main {
            Start(): void {
              const nums: number[] = [1, 2, 3];
              Debug.Log(nums);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const dataSection = getDataSection(result.uasm);

      // After fix: The array variable "nums" should use %VRCSDK3DataDataList
      // in the data section, not %SystemArray
      const numsLines = dataSection.filter((l) => l.includes("nums"));
      expect(numsLines.length).toBeGreaterThan(0);
      const hasSystemArray = numsLines.some((l) => l.includes("%SystemArray"));
      expect(hasSystemArray).toBe(false);
      const hasDataList = numsLines.some((l) =>
        l.includes("%VRCSDK3DataDataList"),
      );
      expect(hasDataList).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 4: SoA inline field DataToken unwrap for DataDictionary/DataList fields
  // ---------------------------------------------------------------------------

  describe("SoA inline field DataToken unwrap", () => {
    it("inline class with Map field accessed after loop should unwrap via DataDictionary", () => {
      // When an inline class has a Map<K,V> field and instances are created
      // in a loop (triggering SoA storage), accessing the Map field should
      // unwrap the DataToken via .DataDictionary, not .Reference.
      // Fixed by PR#119 (CollectionTypeSymbol udonType derivation).
      const source = `
          class Registry {
            public lookup: Map<string, number> = new Map<string, number>();
            constructor() {
              this.lookup.set("a", 1);
            }
          }
          class Main {
            Start(): void {
              const items: Registry[] = [];
              for (let i: number = 0; i < 3; i++) {
                items.push(new Registry());
              }
              const m = items[0].lookup;
              Debug.Log(m.get("a"));
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // The SoA field for 'lookup' should be unwrapped via .DataDictionary
      expect(result.uasm).not.toContain(
        "DataToken.__get_Reference__SystemObject",
      );
      expect(result.uasm).toContain(
        "VRCSDK3DataDataToken.__get_DataDictionary__VRCSDK3DataDataDictionary",
      );
    });

    it("inline class with number[] field accessed after loop should unwrap via DataList", () => {
      // When an inline class has a number[] field and instances are created
      // in a loop, accessing the array field should unwrap the DataToken
      // via .DataList, not .Reference.
      const source = `
          class Container {
            public values: number[] = [10, 20, 30];
          }
          class Main {
            Start(): void {
              const items: Container[] = [];
              for (let i: number = 0; i < 3; i++) {
                items.push(new Container());
              }
              const arr = items[0].values;
              Debug.Log(arr.length);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // The SoA field for 'values' should be unwrapped via .DataList, not .Reference
      expect(result.uasm).not.toContain(
        "DataToken.__get_Reference__SystemObject",
      );
      expect(result.uasm).toContain(
        "VRCSDK3DataDataToken.__get_DataList__VRCSDK3DataDataList",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 5: String boolean coercion (truthy check)
  // ---------------------------------------------------------------------------

  describe("string boolean coercion", () => {
    it.fails("negating a string should not use SystemConvert.ToBoolean", () => {
      // JS: !str is truthy/falsy based on emptiness (non-empty = true).
      // C#: Convert.ToBoolean("hello") throws FormatException.
      // The transpiler should emit a length check or null/empty check
      // instead of SystemConvert.ToBoolean(string).
      const source = `
          class Main {
            Start(): void {
              const str: string = "hello";
              if (!str) {
                Debug.Log("empty");
              } else {
                Debug.Log("not empty");
              }
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // Should NOT call SystemConvert.ToBoolean on a string
      expect(result.uasm).not.toContain(
        "SystemConvert.__ToBoolean__SystemString__SystemBoolean",
      );
      // Should use a length check (get_Length) for string truthiness
      expect(result.uasm).toContain("SystemString.__get_Length__SystemInt32");
    });

    it.fails("string in if-condition with logical NOT should not use SystemConvert.ToBoolean", () => {
      // Pattern from Tile.parse: `if (!rankStr) { ... }`
      // Uses substring (fixed indices) instead of slice to avoid get_Length
      // side-effect from negative-index adjustment.
      const source = `
          class Main {
            Start(): void {
              const s: string = "1m";
              const rankStr: string = s.substring(0, 1);
              if (!rankStr) {
                Debug.Log("invalid");
              }
              Debug.Log(rankStr);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).not.toContain(
        "SystemConvert.__ToBoolean__SystemString__SystemBoolean",
      );
      // Should use a length check for string truthiness
      expect(result.uasm).toContain("SystemString.__get_Length__SystemInt32");
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 6: Array index assignment on empty DataList
  // ---------------------------------------------------------------------------

  describe("array index assignment pre-population", () => {
    it.fails("loop-based index assignment to empty array should use Add instead of set_Item", () => {
      // Pattern from Tile.createCounts():
      //   const counts: number[] = [];
      //   for (let i = 0; i < 34; i++) { counts[i] = 0; }
      //
      // The DataList starts empty. `counts[i] = 0` should use
      // DataList.Add() (append) rather than DataList.set_Item() (update),
      // since set_Item at a non-existent index throws IndexOutOfRange.
      //
      // Alternatively, the transpiler could detect that the loop fills
      // sequentially from 0 and pre-populate the DataList.
      const source = `
          class Main {
            Start(): void {
              const counts: number[] = [];
              for (let i: number = 0; i < 5; i++) {
                counts[i] = 0;
              }
              Debug.Log(counts[0]);
              Debug.Log(counts.length);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // After fix: empty array population should use Add (not bare set_Item)
      expect(result.uasm).toContain(
        "VRCSDK3DataDataList.__Add__VRCSDK3DataDataToken__SystemVoid",
      );
      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataList.__set_Item__SystemInt32_VRCSDK3DataDataToken__SystemVoid",
      );
    });
  });
});

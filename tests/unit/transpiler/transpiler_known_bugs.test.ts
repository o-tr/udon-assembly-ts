/**
 * Regression tests for three known transpiler bugs discovered during VM testing.
 *
 * Bug 1 (FIXED): String.slice() negative index — resolved by replacing
 *         compile-time isNegConst() with a runtime branch in resolveIndex().
 *         (root cause #12 in vm-test-failures-investigation.md)
 *
 * Bug 2: DataToken.get_Reference misselection — CollectionTypeSymbol hardcodes
 *         UdonType.Object, causing DataList/DataDictionary DataTokens to unwrap
 *         with .Reference instead of .DataList/.DataDictionary.
 *         (root cause #11 in vm-test-failures-investigation.md)
 *
 * Bug 3: ArrayTypeSymbol data section type mismatch — the data section declares
 *         array-typed variables as %SystemArray but EXTERN signatures use
 *         VRCSDK3DataDataList.
 *         (root cause #13 in vm-test-failures-investigation.md)
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

    it.fails("Map field in loop-created inline class should unwrap via DataDictionary, not Reference", () => {
      const result = new TypeScriptToUdonTranspiler().transpile(mapFieldSource);

      // After fix: DataToken containing a DataDictionary should unwrap via
      // get_DataDictionary, not get_Reference.
      expect(result.uasm).not.toContain(
        "DataToken.__get_Reference__SystemObject",
      );
    });

    // DELETE this test when the DataToken unwrap bug above is fixed
    it("documents current bug: Map field DataToken uses get_Reference", () => {
      const result = new TypeScriptToUdonTranspiler().transpile(mapFieldSource);

      // BUG: CollectionTypeSymbol at type_symbols.ts:122 calls
      //   super(typeName, UdonType.Object)
      // When unwrapDataToken() is called with this type, targetType.udonType
      // is "Object", falling through to default → property = "Reference".
      // VRChat DataToken throws on get_Reference for DataList/DataDictionary tokens.

      // BUG EVIDENCE: get_Reference is used instead of get_DataDictionary
      expect(result.uasm).toContain("DataToken.__get_Reference__SystemObject");
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

    it.fails("number[] variable should not declare as %SystemArray in data section", () => {
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
      const hasSystemArray = numsLines.some((l) => l.includes("%SystemArray"));
      expect(hasSystemArray).toBe(false);
    });

    // DELETE this test when the ArrayTypeSymbol bug above is fixed
    it("documents current bug: array variable declared as %SystemArray", () => {
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

      // BUG: getOperandAddress() stores varOp.type.udonType which is "Array"
      // for ArrayTypeSymbol, becoming %SystemArray in the data section.
      // But getOperandTypeName() has ArrayTypeSymbol → "VRCSDK3DataDataList"
      // for EXTERN signatures. This mismatch causes VM errors.

      // BUG EVIDENCE: %SystemArray in data section for the "nums" variable
      const numsLines = dataSection.filter((l) => l.includes("nums"));
      const hasSystemArray = numsLines.some((l) => l.includes("%SystemArray"));
      expect(hasSystemArray).toBe(true);

      // EXTERN signatures correctly use DataList (the mismatch)
      expect(result.uasm).toContain("VRCSDK3DataDataList");
    });
  });
});

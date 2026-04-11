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
 * Bug 4 (FIXED): SoA inline field DataToken unwrap — when an inline class field holds a
 *         DataDictionary/DataList (e.g. Map<K,V>), the SoA field type resolves as
 *         ClassTypeSymbol (udonType="Object") instead of preserving the collection
 *         type, causing unwrapDataToken to use .Reference.
 *         (root cause #11 continuation in vm-test-failures-investigation.md)
 *
 * Bug 5 (FIXED): String boolean coercion — `!str` on a string variable generates
 *         SystemConvert.ToBoolean(string) which throws at runtime for any value
 *         other than "True"/"False". JS truthy semantics require non-empty check.
 *         (root cause #15 in vm-test-failures-investigation.md)
 *
 * Bug 6 (FIXED): Array index assignment on empty DataList — `arr[i] = value` in a loop
 *         generates DataList.set_Item but the DataList was never pre-populated,
 *         causing an IndexOutOfRange at runtime.
 *         (root cause #13 continuation in vm-test-failures-investigation.md)
 *
 * Bug 7: HeapTypeMismatchException Int32→Boolean — non-boolean values (Int32,
 *         Single, String, Object) are passed directly to JUMP_IF_FALSE without
 *         coercion to Boolean. The Udon VM strictly requires Boolean for
 *         JUMP_IF_FALSE. Patterns like `if (count)`, `count ? a : b`, and
 *         `if (obj)` all fail at runtime.
 *         (root cause #16 in vm-test-failures-investigation.md)
 *
 * Bug 8: SoA D3 method dispatch miss — tryD3MethodDispatch compares runtime
 *         handles against compile-time instanceId constants. For SoA classes
 *         (loop-created), runtime handles are dynamic counter values that never
 *         match static instanceIds. Method calls on SoA instances always miss.
 *         (root cause #17 in vm-test-failures-investigation.md)
 *
 * Bug 9: DataToken.get_Reference for Map<string, unknown> — when a Map's value
 *         type is `unknown` (or `any`/`object`), it maps to ObjectType. The
 *         unwrapDataToken function's default case uses .Reference, which crashes
 *         at runtime because the DataToken stores a typed value (String, Int, etc.)
 *         that cannot be accessed via .Reference.
 *         (root cause #11 residual in vm-test-failures-investigation.md)
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
    it("negating a string should not use SystemConvert.ToBoolean", () => {
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

    it("string in if-condition with logical NOT should not use SystemConvert.ToBoolean", () => {
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
    it("loop-based index assignment to empty array emits bounds-check-and-grow loop", () => {
      // Pattern from Tile.createCounts():
      //   const counts: number[] = [];
      //   for (let i = 0; i < 34; i++) { counts[i] = 0; }
      //
      // The DataList starts empty. The transpiler now emits a runtime
      // bounds-check-and-grow loop before each set_Item: it calls Add to
      // grow the DataList until Count > index, then set_Item is safe.
      // Note: counts.length (which compiles to get_Count) is intentionally
      // absent from this source so that __get_Count__ can only come from the
      // bounds-check grow loop. counts[0] compiles to get_Item, not get_Count.
      const source = `
          class Main {
            Start(): void {
              const counts: number[] = [];
              for (let i: number = 0; i < 5; i++) {
                counts[i] = 0;
              }
              Debug.Log(counts[0]);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // Grow loop: Add is called when the index is out of bounds
      expect(result.uasm).toContain(
        "VRCSDK3DataDataList.__Add__VRCSDK3DataDataToken__SystemVoid",
      );
      // Bounds check: Count is read each iteration of the grow loop
      expect(result.uasm).toContain(
        "VRCSDK3DataDataList.__get_Count__SystemInt32",
      );
      // Actual write: set_Item is called after the list is large enough
      expect(result.uasm).toContain(
        "VRCSDK3DataDataList.__set_Item__SystemInt32_VRCSDK3DataDataToken__SystemVoid",
      );
    });

    it("index assignment to pre-populated literal array uses native Set (fixed by native-array optimization)", () => {
      // Previously: [1,2,3] with arr[1]=99 generated DataList with a
      // bounds-check-and-grow loop (Add + get_Count + set_Item overhead).
      // Now: constant-length array literals are lowered to native Udon typed
      // arrays (SystemSingleArray), so index assignment uses __Set__ directly
      // with no bounds-check overhead.
      const source = `
          class Main {
            Start(): void {
              const arr: number[] = [1, 2, 3];
              arr[1] = 99;
              Debug.Log(arr[1]);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // Native array ctor and Set/Get — no DataList or DataToken overhead
      expect(result.uasm).toContain(
        "SystemSingleArray.__ctor__SystemInt32__SystemSingleArray",
      );
      expect(result.uasm).toContain(
        "SystemSingleArray.__Set__SystemInt32_SystemSingle__SystemVoid",
      );
      expect(result.uasm).toContain(
        "SystemSingleArray.__Get__SystemInt32__SystemSingle",
      );
      expect(result.uasm).not.toContain("VRCSDK3DataDataList");
      expect(result.uasm).not.toContain("VRCSDK3DataDataToken");
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 7: HeapTypeMismatchException — non-boolean values in JUMP_IF_FALSE
  // ---------------------------------------------------------------------------

  describe("non-boolean truthy coercion for JUMP_IF_FALSE", () => {
    /** Extract the UASM lines immediately before each JUMP_IF_FALSE */
    function getJumpIfFalseContexts(uasm: string): string[][] {
      const lines = uasm.split("\n");
      const contexts: string[][] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("JUMP_IF_FALSE")) {
          contexts.push(lines.slice(Math.max(0, i - 6), i + 1));
        }
      }
      return contexts;
    }

    it("boolean variable in if-condition needs no coercion (baseline)", () => {
      const source = `
        class Main {
          Start(): void {
            const flag: boolean = true;
            if (flag) {
              Debug.Log("yes");
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // Boolean should pass directly to JUMP_IF_FALSE with no extra comparison
      const contexts = getJumpIfFalseContexts(result.uasm);
      expect(contexts.length).toBeGreaterThan(0);
      // The PUSH before JUMP_IF_FALSE should reference the boolean variable
      // No op_Inequality or op_Equality comparison needed
      const jumpContext = contexts[0].join("\n");
      expect(jumpContext).toContain("PUSH, flag");
    });

    it.fails("integer variable in if-condition should be coerced to boolean", () => {
      const source = `
        import { UdonInt } from "../../stubs";
        class Main {
          Start(): void {
            const count: UdonInt = 5;
            if (count) {
              Debug.Log("truthy");
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // After fix: JUMP_IF_FALSE should be preceded by a != 0 comparison
      // that produces a Boolean result.
      const contexts = getJumpIfFalseContexts(result.uasm);
      expect(contexts.length).toBeGreaterThan(0);
      const jumpContext = contexts[0].join("\n");
      // Must have an inequality/equality comparison to produce Boolean
      expect(jumpContext).toMatch(
        /op_Inequality|op_Equality|op_GreaterThan|op_LessThan/,
      );
    });

    it.fails("string variable in if-condition should be coerced to boolean via length check", () => {
      const source = `
        class Main {
          Start(): void {
            const name: string = "hello";
            if (name) {
              Debug.Log("truthy");
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // After fix: should check str.Length != 0 for JS truthiness semantics
      expect(result.uasm).toContain("SystemString.__get_Length__SystemInt32");
      const contexts = getJumpIfFalseContexts(result.uasm);
      expect(contexts.length).toBeGreaterThan(0);
      const jumpContext = contexts[0].join("\n");
      expect(jumpContext).toMatch(/op_Inequality|op_Equality/);
    });

    it.fails("integer ternary condition should be coerced to boolean", () => {
      const source = `
        import { UdonInt } from "../../stubs";
        class Main {
          Start(): void {
            const count: UdonInt = 5;
            const msg: string = count ? "yes" : "no";
            Debug.Log(msg);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // After fix: the ternary condition should have a != 0 comparison
      const contexts = getJumpIfFalseContexts(result.uasm);
      expect(contexts.length).toBeGreaterThan(0);
      const jumpContext = contexts[0].join("\n");
      expect(jumpContext).toMatch(
        /op_Inequality|op_Equality|op_GreaterThan|op_LessThan/,
      );
    });

    it("logical NOT on integer should produce Boolean-typed result", () => {
      const source = `
        import { UdonInt } from "../../stubs";
        class Main {
          Start(): void {
            const count: UdonInt = 5;
            const negated = !count;
            if (negated) {
              Debug.Log("falsy");
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // After fix: the temp for !count should be declared as %SystemBoolean,
      // not %SystemInt32 or %SystemSingle.
      const dataLines = result.uasm.split("\n");
      const startIdx = dataLines.findIndex((l) => l.includes(".data_start"));
      const endIdx = dataLines.findIndex((l) => l.includes(".data_end"));
      const dataSection = dataLines.slice(startIdx, endIdx + 1);

      // All temps used in JUMP_IF_FALSE must be %SystemBoolean.
      // The PUSH immediately before JUMP_IF_FALSE is the condition operand.
      const contexts = getJumpIfFalseContexts(result.uasm);
      expect(contexts.length).toBeGreaterThan(0);
      for (const ctx of contexts) {
        const jifIdx = ctx.findIndex((l) => l.includes("JUMP_IF_FALSE"));
        // Search backwards from JUMP_IF_FALSE for the immediately preceding PUSH
        let pushLine: string | undefined;
        for (let k = jifIdx - 1; k >= 0; k--) {
          if (ctx[k].includes("PUSH") && !ctx[k].includes("EXTERN")) {
            pushLine = ctx[k];
            break;
          }
        }
        expect(pushLine).toBeDefined();
        const varName = pushLine?.trim().replace("PUSH, ", "");
        const dataEntry = dataSection.find((l) =>
          l.trimStart().startsWith(`${varName}:`),
        );
        expect(dataEntry).toBeDefined();
        expect(dataEntry).toContain("%SystemBoolean");
      }
    });

    it.fails("inline class instance in if-condition should be coerced to boolean", () => {
      const source = `
        class Result {
          value: number;
          constructor(value: number) {
            this.value = value;
          }
        }
        class Main {
          Start(): void {
            const results: Result[] = [];
            for (let i: number = 0; i < 3; i++) {
              results.push(new Result(i));
            }
            const r = results[0];
            if (r) {
              Debug.Log("exists");
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // After fix: the inline handle (Int32) should be compared against
      // null or 0 to produce a Boolean before JUMP_IF_FALSE.
      // Use the last JUMP_IF_FALSE context to target the `if (r)` branch,
      // not the for-loop guard.
      const contexts = getJumpIfFalseContexts(result.uasm);
      expect(contexts.length).toBeGreaterThan(0);
      const jumpContext = contexts[contexts.length - 1].join("\n");
      expect(jumpContext).toMatch(/op_Inequality|op_Equality/);
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 8: SoA D3 method dispatch miss
  // ---------------------------------------------------------------------------

  describe("SoA D3 method dispatch", () => {
    it.fails("method call on SoA class instance from for-of loop should not produce dispatch miss", () => {
      const source = `
        class Item {
          value: number;
          label: string;
          constructor(value: number, label: string) {
            this.value = value;
            this.label = label;
          }
          getLabel(): string {
            return this.label;
          }
        }
        class Main {
          Start(): void {
            const items: Item[] = [];
            for (let i: number = 0; i < 3; i++) {
              items.push(new Item(i, "item" + i));
            }
            for (const item of items) {
              Debug.Log(item.getLabel());
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // After fix: SoA fast path should be used instead of per-instance
      // handle comparison that always misses for dynamic SoA handles.
      expect(result.uasm).not.toContain("dispatch miss");
      // Should still read from SoA DataLists
      expect(result.uasm).toContain("__soa_Item_label");
    });

    it.fails("method call on SoA class instance returned from cache should not produce dispatch miss", () => {
      const source = `
        class Tile {
          kind: number;
          code: number;
          constructor(kind: number, code: number) {
            this.kind = kind;
            this.code = code;
          }
          toString(): string {
            return this.kind + ":" + this.code;
          }
          static cache: Tile[] = [];
          static init(): void {
            for (let i: number = 0; i < 9; i++) {
              Tile.cache.push(new Tile(0, i));
            }
          }
          static get(index: number): Tile {
            return Tile.cache[index];
          }
        }
        class Main {
          Start(): void {
            Tile.init();
            const t = Tile.get(3);
            Debug.Log(t.toString());
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // After fix: the returned Tile instance from cache should be
      // dispatchable via SoA fast path.
      expect(result.uasm).not.toContain("dispatch miss");
      // Should read SoA fields for the inlined toString() body
      expect(result.uasm).toContain("__soa_Tile_kind");
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 9: DataToken.get_Reference for Map<string, unknown>
  // ---------------------------------------------------------------------------

  describe("DataToken.get_Reference for unknown-typed Map values", () => {
    it.fails("Map<string, unknown>.get() should not use get_Reference", () => {
      // When a Map's value type is `unknown`, the transpiler maps it to
      // ObjectType. unwrapDataToken's default case falls back to .Reference,
      // but the DataToken actually stores a typed value (e.g. String) that
      // cannot be accessed via .Reference at runtime.
      const source = `
        class LRUCache {
          private cache: Map<string, unknown> = new Map<string, unknown>();

          get(key: string): unknown {
            return this.cache.get(key);
          }

          set(key: string, value: unknown): void {
            this.cache.set(key, value);
          }

          has(key: string): boolean {
            return this.cache.has(key);
          }
        }
        class Main {
          Start(): void {
            const cache = new LRUCache();
            cache.set("a", "hello");
            Debug.Log(cache.has("a"));
            const val = cache.get("a");
            Debug.Log(val);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // After fix: should NOT use .Reference for DataToken unwrap when
      // the stored value is a known primitive type. A runtime TokenType
      // dispatch or type-hint propagation should be used instead.
      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__get_Reference__SystemObject",
      );
    });

    it.fails("Map<string, any>.get() should not use get_Reference", () => {
      const source = `
        class Main {
          Start(): void {
            const m: Map<string, any> = new Map<string, any>();
            m.set("key", 42);
            const val = m.get("key");
            Debug.Log(val);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__get_Reference__SystemObject",
      );
    });
  });
});

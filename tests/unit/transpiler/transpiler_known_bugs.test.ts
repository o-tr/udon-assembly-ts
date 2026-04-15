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
 * Bug 7 (FIXED in transpiler; VM known-fail tracked separately):
 *         HeapTypeMismatchException Int32→Boolean — non-boolean values (Int32,
 *         Single, String, Object) are passed directly to JUMP_IF_FALSE without
 *         coercion to Boolean. The Udon VM strictly requires Boolean for
 *         JUMP_IF_FALSE. Patterns like `if (count)`, `count ? a : b`, and
 *         `if (obj)` all fail at runtime.
 *         (root cause #16 in vm-test-failures-investigation.md)
 *
 * Bug 8 (FIXED in transpiler; VM known-fail tracked separately):
 *         SoA D3 method dispatch miss — tryD3MethodDispatch compares runtime
 *         handles against compile-time instanceId constants. For SoA classes
 *         (loop-created), runtime handles are dynamic counter values that never
 *         match static instanceIds. Method calls on SoA instances always miss.
 *         (root cause #17 in vm-test-failures-investigation.md)
 *
 * Bug 9 (FIXED in transpiler; VM known-fail tracked separately):
 *         DataToken.get_Reference for Map<string, unknown> — when a Map's value
 *         type is `unknown` (or `any`/`object`), it maps to ObjectType. The
 *         unwrapDataToken function's default case uses .Reference, which crashes
 *         at runtime because the DataToken stores a typed value (String, Int, etc.)
 *         that cannot be accessed via .Reference.
 *         (root cause #11 residual in vm-test-failures-investigation.md)
 *
 * Bug 10 (FIXED): DataList.get_Item bounds safety on dynamic cache reads —
 *         non-literal indices emit Count + (index >= 0) + (index < Count) + ifFalse
 *         before get_Item; negative numeric / unary-minus literals use the same guard.
 *         Null DataToken fallback when out of bounds.
 *         (root cause #18 in vm-test-failures-investigation.md)
 *
 * Bug 11 (FIXED): Flyweight cache typed unwrap stability — SoA DataList get_Item
 *         now emits Count / index < Count / ifFalse guards (plus OOB get_Item(0))
 *         before field loads in SoA method dispatch and untracked property reads.
 *         (root cause #19/#20 in vm-test-failures-investigation.md)
 *
 * Bug 13 (OPEN — 9th-run main cause, 26/26 failing VM tests):
 *         VRCSDK3DataDataList.__get_Count__SystemInt32 runtime exception because
 *         the DataList receiver is null / never ctor'd. Root cause is not yet
 *         localized; candidate sources in the investigation report:
 *         (a) inline-class DataList field not ctor'd in constructor,
 *         (b) inline-class Map/Set field not ctor'd in constructor,
 *         (c) SoA __soa_*_field DataList read on an execution path that never
 *             runs emitSoaInitGuard (no `new ClassName(...)` upstream), and
 *         (d) for-of over a Map field before the backing DataDictionary is
 *             ctor'd.
 *
 *         The tests in the "Bug 13 baseline invariants" describe block below
 *         pin down the *simple* shape of each candidate and assert the static
 *         invariant "DataList.__ctor__ must appear before the first
 *         corresponding get_Count in UASM text order". They currently pass on
 *         master, which means the simple minimal reproducers are *not* the
 *         source of #22 — the real failure path is deeper in HandAnalyzer /
 *         yaku / scoring pipelines. Keeping these as positive regression
 *         guards prevents a future refactor from breaking the simple-case
 *         invariant while the full #22 fix is being developed. When a more
 *         minimal reproducer is identified, add it alongside as `it.fails`.
 *         (root cause #22 in vm-test-failures-investigation.md)
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

/** Extract data section lines from UASM (lines between .data_start and .data_end) */
function getDataSection(uasm: string): string[] {
  const lines = uasm.split("\n");
  const startIdx = lines.findIndex((l) => l.includes(".data_start"));
  const endIdx = lines.findIndex((l) => l.includes(".data_end"));
  if (startIdx < 0 || endIdx < 0) return [];
  return lines.slice(startIdx, endIdx + 1);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STRING_SENTINEL_CTOR =
  'call VRCSDK3DataDataToken.__ctor__SystemString__VRCSDK3DataDataToken("")';
const BOOLEAN_SENTINEL_CTOR =
  "call VRCSDK3DataDataToken.__ctor__SystemBoolean__VRCSDK3DataDataToken(false)";
const INT32_ZERO_SENTINEL_CTOR =
  "call VRCSDK3DataDataToken.__ctor__SystemInt32__VRCSDK3DataDataToken(0)";
const OBJECT_NULL_SENTINEL_CTOR =
  "call VRCSDK3DataDataToken.__ctor__SystemObject__VRCSDK3DataDataToken(null)";

/** `indexVar >= 0` / `0 <= indexVar` assignment must be followed by ifFalse/if on that temp. */
function hasLowerBoundGuardBranch(
  guardScanLines: string[],
  indexVar: string,
): boolean {
  const escapedIndexVar = escapeRegex(indexVar);
  const lowerAssignRe = new RegExp(
    `^([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(?:${escapedIndexVar}\\s*>=\\s*0|0\\s*<=\\s*${escapedIndexVar})`,
  );
  for (let i = 0; i < guardScanLines.length; i++) {
    const m = guardScanLines[i].trim().match(lowerAssignRe);
    if (!m?.[1]) continue;
    const lbTemp = m[1];
    const branchPattern = new RegExp(
      `^(ifFalse|ifTrue|if)\\s+${escapeRegex(lbTemp)}\\s+goto\\b`,
    );
    if (
      guardScanLines
        .slice(i + 1)
        .some((line) => branchPattern.test(line.trim()))
    ) {
      return true;
    }
  }
  return false;
}

function detectIndexAwareGuardBeforeGetItem(
  tacLines: string[],
  getItemIdx: number,
  countAssignmentPattern: RegExp,
  requireLowerBound = false,
): boolean {
  if (getItemIdx <= 0 || getItemIdx >= tacLines.length) return false;

  const getItemLine = tacLines[getItemIdx];
  const indexVarMatch = getItemLine.match(/get_Item\(([^)]+)\)/);
  const indexVar = indexVarMatch?.[1]?.trim();
  if (!indexVar) return false;
  const escapedIndexVar = escapeRegex(indexVar);

  // Scope the scan to the enclosing TAC label block to avoid accidental
  // matches from unrelated earlier blocks/method fragments.
  let blockStart = 0;
  for (let i = getItemIdx - 1; i >= 0; i--) {
    if (/^[A-Za-z_][A-Za-z0-9_]*:$/.test(tacLines[i].trim())) {
      blockStart = i + 1;
      break;
    }
  }
  const collectCountAssignments = (
    lines: string[],
  ): { i: number; countVar: string }[] =>
    lines
      .map((line, i) => ({
        i,
        countVar: line.trim().match(countAssignmentPattern)?.[1],
      }))
      .filter(
        (entry): entry is { i: number; countVar: string } => !!entry.countVar,
      );

  let guardScanLines = tacLines.slice(blockStart, getItemIdx);
  let countAssignments = collectCountAssignments(guardScanLines);
  // OOB `get_Item(0)` often follows a label while `.Count` was read earlier in
  // the same helper; allow matching that assignment by scanning from TAC start.
  if (countAssignments.length === 0) {
    guardScanLines = tacLines.slice(0, getItemIdx);
    countAssignments = collectCountAssignments(guardScanLines);
  }
  if (countAssignments.length === 0) return false;

  const countVars = [
    ...new Set(countAssignments.map((entry) => entry.countVar)),
  ];
  const matched = countVars.some((countVar) => {
    const assignIndices = countAssignments
      .filter((entry) => entry.countVar === countVar)
      .map((entry) => entry.i);
    if (assignIndices.length === 0) return false;

    const escapedCountVar = escapeRegex(countVar);
    const comparisonPattern = new RegExp(
      `^([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(?:${escapedIndexVar}\\s*(<|<=|>|>=)\\s*${escapedCountVar}|${escapedCountVar}\\s*(<|<=|>|>=)\\s*${escapedIndexVar})$`,
    );
    return assignIndices.some((assignIdx) => {
      const afterAssign = guardScanLines.slice(assignIdx + 1);

      for (let i = 0; i < afterAssign.length; i++) {
        const comparisonMatch = afterAssign[i].trim().match(comparisonPattern);
        if (!comparisonMatch?.[1]) continue;

        const cmpTemp = comparisonMatch[1];
        const escapedCmpTemp = escapeRegex(cmpTemp);
        const branchPattern = new RegExp(
          `^(ifFalse|ifTrue|if)\\s+${escapedCmpTemp}\\s+goto\\b`,
        );
        const hasGuardBranch = afterAssign
          .slice(i + 1)
          .some((line) => branchPattern.test(line.trim()));
        if (hasGuardBranch) return true;
      }

      return false;
    });
  });
  if (!matched) return false;
  if (requireLowerBound) {
    return hasLowerBoundGuardBranch(guardScanLines, indexVar);
  }
  return true;
}

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

      // Negative index requires get_Length to compute length + offset
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

      // Negative start index requires get_Length to compute length + offset
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

      // The array variable "nums" uses %VRCSDK3DataDataList in the data
      // section, not %SystemArray
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
    const CONTEXT_LINES = 10;
    function getJumpIfFalseContexts(uasm: string): string[][] {
      const lines = uasm.split("\n");
      const contexts: string[][] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("JUMP_IF_FALSE")) {
          contexts.push(lines.slice(Math.max(0, i - CONTEXT_LINES), i + 1));
        }
      }
      return contexts;
    }

    /**
     * Assert that every PUSH immediately before a JUMP_IF_FALSE references
     * a %SystemBoolean variable in the data section.
     */
    function assertJumpIfFalseUsesBoolean(
      uasm: string,
      dataSection: string[],
    ): void {
      const contexts = getJumpIfFalseContexts(uasm);
      expect(contexts.length).toBeGreaterThan(0);
      for (const ctx of contexts) {
        // The target JUMP_IF_FALSE is always the last element of the context.
        // Use length-1 instead of findIndex to avoid matching a prior
        // JUMP_IF_FALSE that falls within the context window.
        const jifIdx = ctx.length - 1;
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

    it("integer variable in if-condition should be coerced to boolean", () => {
      const source = `
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
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
      const dataSection = getDataSection(result.uasm);

      // After fix: JUMP_IF_FALSE should be preceded by a != 0 comparison
      // that produces a Boolean result.
      expect(result.uasm).toMatch(
        /op_Inequality|op_Equality|op_GreaterThan|op_LessThan/,
      );
      assertJumpIfFalseUsesBoolean(result.uasm, dataSection);
    });

    it("string variable in if-condition should be coerced to boolean via IsNullOrEmpty", () => {
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
      const dataSection = getDataSection(result.uasm);

      // After fix: should use String.IsNullOrEmpty for null-safe truthiness
      expect(result.uasm).toContain(
        "SystemString.__IsNullOrEmpty__SystemString__SystemBoolean",
      );
      assertJumpIfFalseUsesBoolean(result.uasm, dataSection);
    });

    it("integer ternary condition should be coerced to boolean", () => {
      const source = `
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        class Main {
          Start(): void {
            const count: UdonInt = 5;
            const msg: string = count ? "yes" : "no";
            Debug.Log(msg);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const dataSection = getDataSection(result.uasm);

      // After fix: the ternary condition should have a != 0 comparison
      expect(result.uasm).toMatch(
        /op_Inequality|op_Equality|op_GreaterThan|op_LessThan/,
      );
      assertJumpIfFalseUsesBoolean(result.uasm, dataSection);
    });

    it("logical NOT on integer should produce Boolean-typed result", () => {
      const source = `
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
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
      const dataSection = getDataSection(result.uasm);

      // The `!` operator always produces a Boolean-typed result in TAC,
      // so the variable and all intermediate temps are %SystemBoolean.
      // JUMP_IF_FALSE receives a Boolean push, avoiding HeapTypeMismatchException.
      assertJumpIfFalseUsesBoolean(result.uasm, dataSection);
    });

    it("inline class instance in if-condition should be coerced to boolean", () => {
      // No for-loop or other conditionals — the only JUMP_IF_FALSE in the
      // output corresponds to `if (r)`, so contexts[0] is unambiguous.
      const source = `
        class Result {
          value: number;
          constructor(value: number) {
            this.value = value;
          }
        }
        class Main {
          Start(): void {
            const r = new Result(42);
            if (r) {
              Debug.Log("exists");
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const dataSection = getDataSection(result.uasm);

      // After fix: the inline handle (Int32) should be compared against
      // null or 0 to produce a Boolean before JUMP_IF_FALSE.
      expect(result.uasm).toMatch(/op_Inequality|op_Equality/);
      assertJumpIfFalseUsesBoolean(result.uasm, dataSection);
    });

    it("short-circuit AND with non-boolean operands should coerce both sides", () => {
      const source = `
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        class Main {
          Start(): void {
            const a: UdonInt = 1;
            const b: UdonInt = 2;
            if (a && b) {
              Debug.Log("both truthy");
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const dataSection = getDataSection(result.uasm);

      // Both operands should be coerced; all JUMP_IF_FALSE must use Boolean
      assertJumpIfFalseUsesBoolean(result.uasm, dataSection);
    });

    it("short-circuit OR with non-boolean operands should coerce both sides", () => {
      const source = `
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        class Main {
          Start(): void {
            const a: UdonInt = 0;
            const b: UdonInt = 1;
            if (a || b) {
              Debug.Log("at least one truthy");
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const dataSection = getDataSection(result.uasm);

      assertJumpIfFalseUsesBoolean(result.uasm, dataSection);
    });

    it("non-boolean while-loop condition should be coerced to boolean", () => {
      const source = `
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        class Main {
          Start(): void {
            let n: UdonInt = 5;
            while (n) {
              Debug.Log(n);
              n = (n - 1) as UdonInt;
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const dataSection = getDataSection(result.uasm);

      assertJumpIfFalseUsesBoolean(result.uasm, dataSection);
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 8: SoA D3 method dispatch miss
  // ---------------------------------------------------------------------------

  describe("SoA D3 method dispatch", () => {
    it("method call on SoA class instance from for-of loop should not produce dispatch miss", () => {
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
      // SoA fast path prologue should load fields from DataLists
      expect(result.tac).toContain("__soa_Item_label.get_Item");
      // getLabel() is read-only — no field write-back expected
      expect(result.tac).not.toContain("__soa_Item_label.set_Item");
    });

    it("method call on SoA class instance returned from cache should not produce dispatch miss", () => {
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
      // SoA fast path prologue should load fields from DataLists
      expect(result.tac).toContain("__soa_Tile_kind.get_Item");
      // toString() is read-only — no field write-back expected
      expect(result.tac).not.toContain("__soa_Tile_kind.set_Item");
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 9: DataToken.get_Reference for Map<string, unknown>
  // ---------------------------------------------------------------------------

  describe("DataToken.get_Reference for unknown-typed Map values", () => {
    it("Map<string, unknown>.get() should not use get_Reference", () => {
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
      // The Map.get() path via DataDictionary.get_Item must still be present
      expect(result.uasm).toContain(
        "VRCSDK3DataDataDictionary.__get_Item__VRCSDK3DataDataToken__VRCSDK3DataDataToken",
      );
    });

    it("Map<string, any>.get() should not use get_Reference", () => {
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
      // The Map.get() path via DataDictionary.get_Item must still be present
      expect(result.uasm).toContain(
        "VRCSDK3DataDataDictionary.__get_Item__VRCSDK3DataDataToken__VRCSDK3DataDataToken",
      );
    });

    it("Map<string, unknown>.get() cast to string should unwrap via String", () => {
      const source = `
        class Main {
          Start(): void {
            const m: Map<string, unknown> = new Map<string, unknown>();
            m.set("key", "hello");
            const val = m.get("key") as string;
            Debug.Log(val);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).toContain(
        "VRCSDK3DataDataToken.__get_String__SystemString",
      );
      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__get_Reference__SystemObject",
      );
    });

    it("Map<string, unknown>.keys().next().value should not use get_Reference", () => {
      const source = `
        class Main {
          Start(): void {
            const m: Map<string, unknown> = new Map<string, unknown>();
            m.set("a", "hello");
            const firstKey = m.keys().next().value;
            if (firstKey !== undefined) {
              m.delete(firstKey);
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).toContain(
        "VRCSDK3DataDataToken.__get_String__SystemString",
      );
      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__get_Reference__SystemObject",
      );
    });

    it("Map<string, any>.get() result variable should be DataToken-typed in data section", () => {
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
      const dataSection = getDataSection(result.uasm);

      // The variable 'val' should be typed as DataToken (not SystemObject)
      // because unwrapDataToken returns the DataToken operand as-is
      // (rather than unwrapping to a typed temporary), preserving its
      // original DataToken type.
      const valLine = dataSection.find((l) => l.trimStart().startsWith("val:"));
      expect(valLine).toBeDefined();
      expect(valLine).toContain("%VRCSDK3DataDataToken");
    });

    it("Map<string, string>.get() should still use typed unwrap (regression guard)", () => {
      // When the value type is known (e.g. string), unwrapDataToken must
      // still use the typed accessor (.String), not skip the unwrap.
      const source = `
        class Main {
          Start(): void {
            const m: Map<string, string> = new Map<string, string>();
            m.set("key", "hello");
            const val: string = m.get("key");
            Debug.Log(val);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // Typed Map should use .String accessor, not .Reference
      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__get_Reference__SystemObject",
      );
      expect(result.uasm).toContain(
        "VRCSDK3DataDataToken.__get_String__SystemString",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 10: DataList.get_Item bounds safety
  // ---------------------------------------------------------------------------

  describe("DataList.get_Item bounds safety", () => {
    it("dynamic cache index reads should emit index-aware Count guard before get_Item", () => {
      const source = `
          class Item {
            constructor(public value: number) {}
            static cache: Item[] = [];
            static seed(): void {
              for (let i: number = 0; i < 3; i++) {
                Item.cache.push(new Item(i));
              }
            }
            static at(index: number): Item {
              return Item.cache[index];
            }
          }
          class Main {
            Start(): void {
              Item.seed();
              const it = Item.at(1);
              Debug.Log(it.value);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const tacLines = result.tac.split("\n");
      const cacheGetIdx = tacLines.findIndex((l) =>
        l.includes("Item__cache.get_Item("),
      );
      expect(cacheGetIdx).toBeGreaterThan(0);

      const hasIndexAwareGuard = detectIndexAwareGuardBeforeGetItem(
        tacLines,
        cacheGetIdx,
        /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Item__cache\.Count$/,
        true,
      );

      expect(hasIndexAwareGuard).toBe(true);
    });

    it("primitive number[] cache with negative literal and unary-minus indices emit guards", () => {
      const source = `
          class Item {
            static cache: number[] = [];
            static seed(): void {
              for (let i: number = 0; i < 3; i++) {
                Item.cache.push(i);
              }
            }
            static at(index: number): number {
              return Item.cache[index];
            }
          }
          class Main {
            Start(): void {
              Item.seed();
              Debug.Log(Item.at(-1));
              Debug.Log(Item.at(-(1)));
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const tacLines = result.tac.split("\n");
      const getIndices = tacLines
        .map((l, idx) => (l.includes("Item__cache.get_Item(") ? idx : -1))
        .filter((idx) => idx >= 0);
      expect(getIndices.length).toBeGreaterThanOrEqual(2);

      for (const idx of getIndices) {
        expect(
          detectIndexAwareGuardBeforeGetItem(
            tacLines,
            idx,
            /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Item__cache\.Count$/,
            true,
          ),
        ).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 11: Flyweight cache typed unwrap stability
  // ---------------------------------------------------------------------------

  describe("flyweight cache typed unwrap stability", () => {
    it("cache-returned inline instance should use String/Boolean accessors without Reference fallback", () => {
      const source = `
        class Tile {
          constructor(public label: string, public isRed: boolean) {}
          getLabel(): string {
            return this.label;
          }
          static cache: Tile[] = [];
          static init(): void {
            for (let i: number = 0; i < 3; i++) {
              Tile.cache.push(new Tile("tile" + i, i === 0));
            }
          }
          static parse(_s: string): Tile {
            return Tile.cache[1];
          }
        }
        class Main {
          Start(): void {
            Tile.init();
            const t = Tile.parse("1m");
            Debug.Log(t.getLabel());
            Debug.Log(t.isRed);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const tacLines = result.tac.split("\n");

      expect(result.uasm).toContain(
        "VRCSDK3DataDataList.__get_Item__SystemInt32__VRCSDK3DataDataToken",
      );
      expect(result.uasm).toContain(
        "VRCSDK3DataDataToken.__get_String__SystemString",
      );
      expect(result.uasm).toContain(
        "VRCSDK3DataDataToken.__get_Boolean__SystemBoolean",
      );
      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__get_Reference__SystemObject",
      );
      expect(result.uasm).not.toContain("dispatch miss"); // guard against codegen fallback label emitted on unresolved dispatch

      const soaGetIndices = tacLines
        .map((line, idx) =>
          line.includes("__soa_Tile_label.get_Item(") ||
          line.includes("__soa_Tile_isRed.get_Item(")
            ? idx
            : -1,
        )
        .filter((idx) => idx >= 0);
      expect(soaGetIndices.length).toBeGreaterThan(0);

      for (const soaGetIdx of soaGetIndices) {
        const hasHandleGuard = detectIndexAwareGuardBeforeGetItem(
          tacLines,
          soaGetIdx,
          /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*__soa_Tile_(label|isRed)\.Count$/,
        );
        expect(hasHandleGuard).toBe(true);
      }
    });

    it("SoA sentinel tokens for string/boolean fields should avoid Int32 DataToken ctor", () => {
      const source = `
        class Tile {
          constructor(public label: string, public isRed: boolean) {}
          static cache: Tile[] = [];
          static init(): void {
            for (let i: number = 0; i < 2; i++) {
              Tile.cache.push(new Tile("tile" + i, i === 0));
            }
          }
        }
        class Main {
          Start(): void {
            Tile.init();
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.tac).toContain(STRING_SENTINEL_CTOR);
      expect(result.tac).toContain(BOOLEAN_SENTINEL_CTOR);
      // Int32 token ctor is still valid for handle wrapping in Tile.cache.
      // What we forbid is an Int32 sentinel literal at index 0.
      expect(result.tac).not.toContain(INT32_ZERO_SENTINEL_CTOR);
    });

    it("SoA sentinel tokens for reference fields should use null object token", () => {
      const source = `
        class Holder {
          constructor(public target: GameObject) {}
          static cache: Holder[] = [];
          static init(): void {
            for (let i: number = 0; i < 2; i++) {
              Holder.cache.push(new Holder(null as unknown as GameObject));
            }
          }
        }
        class Main {
          Start(): void {
            Holder.init();
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.tac).toContain(OBJECT_NULL_SENTINEL_CTOR);
      expect(result.tac).not.toContain(INT32_ZERO_SENTINEL_CTOR);
    });

    it("LRU-like Map<string, string>.get flow should keep typed String unwrap", () => {
      const source = `
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        class LRUCache {
          private cache: Map<string, string> = new Map<string, string>();
          private maxSize: UdonInt;
          constructor(maxSize: UdonInt) {
            this.maxSize = maxSize;
          }
          get(key: string): string {
            if (!this.cache.has(key)) return "";
            const value = this.cache.get(key)!;
            this.cache.delete(key);
            this.cache.set(key, value);
            if (this.cache.size != this.maxSize) {
              Debug.Log("neq");
            }
            if (this.cache.size > this.maxSize) {
              Debug.Log("gt");
            }
            return value;
          }
          seed(): void {
            this.cache.set("a", "hello");
          }
        }
        class Main {
          Start(): void {
            const c = new LRUCache(2 as UdonInt);
            c.seed();
            Debug.Log(c.get("a"));
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).toContain(
        "VRCSDK3DataDataDictionary.__get_Item__VRCSDK3DataDataToken__VRCSDK3DataDataToken",
      );
      expect(result.uasm).toContain(
        "VRCSDK3DataDataToken.__get_String__SystemString",
      );
      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__get_Reference__SystemObject",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 12: LessThan guard operand Int32 normalization
  // ---------------------------------------------------------------------------

  describe("LessThan guard operand Int32 normalization", () => {
    it("SoA property read from any-annotated local keeps Int32 handle for index<Count guard", () => {
      const source = `
        class Tile {
          constructor(public code: number) {}
        }
        class Main {
          Start(): void {
            const tiles: Tile[] = [];
            for (let i: number = 0; i < 3; i++) {
              tiles.push(new Tile(i));
            }
            const boxed: any = tiles[1];
            Debug.Log(boxed.code);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // The unwrap of a Tile[] element produces an Int32 handle directly, so
      // the SoA bounds check operates on a real Int32 slot (no redundant
      // SystemConvert.ToInt32(Object) round-trip through an Object temp).
      expect(result.tac).toContain("__soa_Tile_code.get_Item");
      expect(result.uasm).not.toContain(
        "SystemConvert.__ToInt32__SystemObject__SystemInt32",
      );
      expect(result.uasm).toContain(
        "SystemInt32.__op_LessThan__SystemInt32_SystemInt32__SystemBoolean",
      );
    });

    it("SoA method dispatch from any-annotated local keeps Int32 handle", () => {
      const source = `
        class Tile {
          constructor(public code: number) {}
          toLabel(): string {
            return "t" + this.code;
          }
        }
        class Main {
          Start(): void {
            const tiles: Tile[] = [];
            for (let i: number = 0; i < 3; i++) {
              tiles.push(new Tile(i));
            }
            const boxed: any = tiles[2];
            Debug.Log(boxed.toLabel());
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.tac).toContain("__soa_Tile_code.get_Item");
      expect(result.uasm).not.toContain(
        "SystemConvert.__ToInt32__SystemObject__SystemInt32",
      );
      expect(result.uasm).not.toContain("dispatch miss");
    });

    it("for-of path with boxed loop variable keeps Int32 normalization for SoA access", () => {
      const source = `
        class Tile {
          constructor(public code: number) {}
          toLabel(): string {
            return "t" + this.code;
          }
        }
        class Main {
          Start(): void {
            const tiles: Tile[] = [];
            for (let i: number = 0; i < 3; i++) {
              tiles.push(new Tile(i));
            }
            for (const t of tiles) {
              const boxed: any = t;
              Debug.Log(boxed.code);
              Debug.Log(boxed.toLabel());
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.tac).toContain("__soa_Tile_code.get_Item");
      expect(result.uasm).toContain(
        "SystemConvert.__ToInt32__SystemObject__SystemInt32",
      );
      expect(result.uasm).not.toContain("dispatch miss");
    });
  });

  describe("tile-like DataToken accessor mismatch regressions", () => {
    const buildTileLikeSource = (body: string): string => `
      class Tile {
        constructor(public label: string, public isRed: boolean) {}
        static cache: Tile[] = [];
        static init(): void {
          for (let i: number = 0; i < 2; i++) {
            Tile.cache.push(new Tile("5m" + i, i === 0));
          }
        }
        static parse(_raw: string): Tile {
          return Tile.cache[0];
        }
      }
      class Main {
        Start(): void {
          Tile.init();
          const tile = Tile.parse("5m");
          ${body}
        }
      }
    `;

    const cases: Array<{
      name: string;
      body: string;
      accessor: string;
    }> = [
      {
        name: "tile_parse-like flow keeps string unwrap",
        body: "Debug.Log(tile.label);",
        accessor: "VRCSDK3DataDataToken.__get_String__SystemString",
      },
      {
        name: "tile_predicates-like flow keeps string unwrap",
        body: "Debug.Log(tile.label.substring(0, 1));",
        accessor: "VRCSDK3DataDataToken.__get_String__SystemString",
      },
      {
        name: "meld_validation-like flow keeps string unwrap",
        body: 'const meldLabel: string = "pon-" + tile.label; Debug.Log(meldLabel);',
        accessor: "VRCSDK3DataDataToken.__get_String__SystemString",
      },
      {
        name: "tile_dora-like flow keeps boolean unwrap",
        body: "Debug.Log(tile.isRed);",
        accessor: "VRCSDK3DataDataToken.__get_Boolean__SystemBoolean",
      },
      {
        name: "dora_calculator-like flow keeps boolean unwrap",
        body: "const hasDora: boolean = tile.isRed && tile.label.length > 0; Debug.Log(hasDora);",
        accessor: "VRCSDK3DataDataToken.__get_Boolean__SystemBoolean",
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        const result = new TypeScriptToUdonTranspiler().transpile(
          buildTileLikeSource(testCase.body),
        );

        expect(result.uasm).toContain(testCase.accessor);
        expect(result.tac).toContain(STRING_SENTINEL_CTOR);
        expect(result.tac).toContain(BOOLEAN_SENTINEL_CTOR);
        expect(result.tac).not.toContain(INT32_ZERO_SENTINEL_CTOR);
      });
    }

    it("tile_dora-like boolean flow should not require DataToken String accessor", () => {
      const source = `
        class Tile {
          constructor(public label: string, public isRed: boolean) {}
          static cache: Tile[] = [];
          static init(): void {
            for (let i: number = 0; i < 2; i++) {
              Tile.cache.push(new Tile("5m" + i, i === 0));
            }
          }
          static parse(_raw: string): Tile {
            return Tile.cache[0];
          }
          static isDoraIndicatorFor(indicator: Tile, target: Tile): boolean {
            return indicator.isRed === target.isRed;
          }
        }
        class Main {
          Start(): void {
            Tile.init();
            const indicator = Tile.parse("1m");
            const target = Tile.parse("2m");
            Debug.Log(Tile.isDoraIndicatorFor(indicator, target) ? "True" : "False");
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).toContain(
        "VRCSDK3DataDataToken.__get_Boolean__SystemBoolean",
      );
      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__get_String__SystemString",
      );
    });

    it("boolean-literal constructor arg is not clobbered by false in inlined body", () => {
      // Regression for: the else-if(Boolean) block inside saveAndBindInlineParams
      // emitted a second CopyInstruction(param, false) whenever the arg was a
      // Constant or Temporary — silently overriding the real value with false.
      const source = `
        class Box {
          constructor(public flag: boolean) {}
          check(): boolean {
            return this.flag;
          }
        }
        class Main {
          Start(): void {
            const b = new Box(true);
            Debug.Log(b.check() ? "yes" : "no");
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // The param binding must copy the literal true into the flag variable.
      expect(result.tac).toContain("flag = true");
      // No subsequent override with false must appear for the same variable.
      expect(result.tac).not.toContain("flag = false");
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 13: DataList.get_Count receiver null / uninitialized (OPEN)
  // ---------------------------------------------------------------------------
  //
  // 9th-run main cause (2026-04-15): 26/26 failing VM tests crash at
  // VRCSDK3DataDataList.__get_Count__SystemInt32, which is a valid EXTERN.
  // The runtime exception therefore implies the DataList receiver is null
  // (i.e. it was never ctor'd on this execution path).
  //
  // The simple minimal reproducers below currently compile correctly: ctor
  // precedes every get_Count in UASM text order. That means #22's real source
  // is a more complex shape (deep HandAnalyzer/yaku/scoring call chains, or a
  // cross-method inline-tracking loss). These baseline tests are kept as
  // positive regression guards so that if a future refactor breaks the
  // simple-case invariant "ctor before get_Count", CI catches it
  // immediately. Add `it.fails` reproducers alongside once a minimized shape
  // of the real #22 bug is identified.

  describe("Bug 13 baseline invariants: DataList ctor precedes get_Count", () => {
    /**
     * Assert that every VRCSDK3Data{DataList,DataDictionary}.__get_Count__
     * EXTERN in uasm is preceded by at least one matching __ctor__ EXTERN.
     * Text-order is a conservative proxy for execution-order in these small
     * single-Start fixtures. This catches the specific shape of #22 at the
     * static UASM level: a get_Count on a receiver that never saw a ctor.
     */
    const expectCtorBeforeCount = (
      uasm: string,
      listKind: "DataList" | "DataDictionary",
    ): void => {
      const ctorSig = `VRCSDK3Data${listKind}.__ctor____VRCSDK3Data${listKind}`;
      const countSig = `VRCSDK3Data${listKind}.__get_Count__SystemInt32`;
      const countIdx = uasm.indexOf(countSig);
      if (countIdx < 0) return; // nothing to check
      const ctorIdx = uasm.indexOf(ctorSig);
      expect(ctorIdx).toBeGreaterThanOrEqual(0);
      expect(ctorIdx).toBeLessThan(countIdx);
    };

    it("(13a) inline class DataList field — ctor precedes get_Count", () => {
      const source = `
        class Bag {
          items: DataList;
          constructor() {
            this.items = new DataList();
          }
          count(): number {
            return this.items.Count;
          }
        }
        class Main {
          Start(): void {
            const b = new Bag();
            Debug.Log(b.count());
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // DataList field must be declared as %VRCSDK3DataDataList in the data
      // section (not %SystemObject / %SystemArray), otherwise the ctor call
      // cannot land on the correct slot at runtime.
      const dataSection = getDataSection(result.uasm).join("\n");
      expect(dataSection).toMatch(
        /__inst_Bag_\d+_items:\s*%VRCSDK3DataDataList/,
      );
      expectCtorBeforeCount(result.uasm, "DataList");
    });

    it("(13b) inline class Map field — DataDictionary ctor precedes size read", () => {
      const source = `
        class Lookup {
          private table: Map<string, number>;
          constructor() {
            this.table = new Map<string, number>();
          }
          size(): number {
            return this.table.size;
          }
        }
        class Main {
          Start(): void {
            const l = new Lookup();
            Debug.Log(l.size());
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).toContain(
        "VRCSDK3DataDataDictionary.__ctor____VRCSDK3DataDataDictionary",
      );
      expectCtorBeforeCount(result.uasm, "DataDictionary");
    });

    it("(13c) static cache field — ctor emitted in entry even without `new`", () => {
      // Candidate cause #1: emitSoaInitGuard only runs at constructor call
      // sites, so a Start() path that reaches a static cache DataList read
      // without first invoking `new Tile(...)` could (in principle) see an
      // uninitialized list. The minimal-case transpiler currently emits a
      // DataList ctor for `Tile.cache` at entry regardless, so this test
      // pins that behavior: if a future refactor moves ctor emission into a
      // branch that can be skipped, the assertion fails.
      const source = `
        class Tile {
          constructor(public code: number) {}
          static cache: Tile[] = [];
          static at(index: number): Tile {
            return Tile.cache[index];
          }
        }
        class Main {
          Start(): void {
            Debug.Log(Tile.at(0).code);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // Tile.cache must be declared as %VRCSDK3DataDataList.
      const dataSection = getDataSection(result.uasm).join("\n");
      expect(dataSection).toMatch(/Tile__cache:\s*%VRCSDK3DataDataList/);
      expectCtorBeforeCount(result.uasm, "DataList");
    });

    it("(13d) for-of over Map keys — DataDictionary ctor precedes GetKeys", () => {
      const source = `
        class Registry {
          entries: Map<string, number>;
          constructor() {
            this.entries = new Map<string, number>();
            this.entries.set("a", 1);
          }
          dump(): void {
            for (const k of this.entries.keys()) {
              Debug.Log(k);
            }
          }
        }
        class Main {
          Start(): void {
            const r = new Registry();
            r.dump();
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      const dictCtor = result.uasm.indexOf(
        "VRCSDK3DataDataDictionary.__ctor____VRCSDK3DataDataDictionary",
      );
      const getKeys = result.uasm.indexOf(
        "VRCSDK3DataDataDictionary.__GetKeys__VRCSDK3DataDataList",
      );
      expect(dictCtor).toBeGreaterThanOrEqual(0);
      expect(getKeys).toBeGreaterThan(dictCtor);
      // The keys DataList returned by GetKeys is ctor'd by the EXTERN itself,
      // so get_Count on the keys-list handle does not require a separate
      // DataList ctor. The invariant we check is the dict ctor → GetKeys
      // ordering above; any get_Count that appears on the dict path would be
      // covered by expectCtorBeforeCount on DataDictionary.
      expectCtorBeforeCount(result.uasm, "DataDictionary");
    });
  });

  describe("recurrence monitors for previously surfaced VM failures", () => {
    it("HeapTypeMismatch monitor: numeric condition emits Int32->Boolean comparison path", () => {
      const source = `
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        class Main {
          Start(): void {
            const count: UdonInt = 2;
            if (count) {
              Debug.Log("truthy");
            } else {
              Debug.Log("falsy");
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).toContain(
        "SystemInt32.__op_Inequality__SystemInt32_SystemInt32__SystemBoolean",
      );
    });

    it("dispatch miss monitor: SoA loop-created instances keep fast-path dispatch", () => {
      const source = `
        class Item {
          constructor(public label: string) {}
          show(): string {
            return this.label;
          }
        }
        class Main {
          Start(): void {
            const items: Item[] = [];
            for (let i: number = 0; i < 3; i++) {
              items.push(new Item("item" + i));
            }
            for (const item of items) {
              Debug.Log(item.show());
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.tac).toContain("__soa_Item_label.get_Item");
      expect(result.uasm).not.toContain("dispatch miss");
    });

    it("get_Reference monitor: unknown-typed Map.get flow avoids Reference fallback", () => {
      const source = `
        class Main {
          Start(): void {
            const cache: Map<string, unknown> = new Map<string, unknown>();
            cache.set("a", "hello");
            const value = cache.get("a") as string;
            Debug.Log(value);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).toContain(
        "VRCSDK3DataDataToken.__get_String__SystemString",
      );
      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__get_Reference__SystemObject",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Tile sort compare + parser scope regressions (fixed)
  // ---------------------------------------------------------------------------

  describe("tile sort compare + parser scope regressions (fixed)", () => {
    it("tile_sort_compare-like compare flow should not rely on Object->Int32 conversion", () => {
      // Note: Tile.parse uses a plain ternary rather than the original
      // `UdonTypeConverters.toUdonInt(raw.substring(0, 1).length)` expression.
      // The substring(0,1).length chain triggers a separate bug (SystemString.
      // __substring__ returns Object, so .length resolves to ObjectType) that
      // is out of scope for this compare-flow fix. The intent of this test is
      // to verify that Tile.compare emits Int32 arithmetic only, independent
      // of the parse implementation detail.
      const source = `
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        import { UdonTypeConverters } from "@ootr/udon-assembly-ts/stubs/UdonTypes";

        class Tile {
          constructor(public kind: UdonInt) {}
          static parse(raw: string): Tile {
            return new Tile(
              UdonTypeConverters.toUdonInt(raw === "1m" ? 1 : 2),
            );
          }
          static compare(a: Tile, b: Tile): UdonInt {
            const d = (a.kind as number) - (b.kind as number);
            return UdonTypeConverters.toUdonInt(d);
          }
        }

        class Main {
          Start(): void {
            const cmp1 = Tile.compare(Tile.parse("1m"), Tile.parse("2m"));
            const cmp2 = Tile.compare(Tile.parse("2m"), Tile.parse("1m"));
            Debug.Log(cmp1 < (0 as UdonInt) ? "LT" : "GE");
            Debug.Log(cmp2 > (0 as UdonInt) ? "GT" : "LE");
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).toContain(
        "SystemInt32.__op_LessThan__SystemInt32_SystemInt32__SystemBoolean",
      );
      expect(result.uasm).toContain(
        "SystemInt32.__op_GreaterThan__SystemInt32_SystemInt32__SystemBoolean",
      );
      expect(result.uasm).not.toContain(
        "SystemConvert.__ToInt32__SystemObject__SystemInt32",
      );
    });

    it("constructor body element-access on parameter-typed array unwraps as Int32 handle", () => {
      // Regression: visitClassDeclaration's constructor branch visited the
      // body without registering parameters in the symbol table first. So
      // `const first = input[0]` inside the constructor body called
      // inferType(input[0]); inferType for ElementAccess walks the symbol
      // table to find `input` — and not finding it, fell back to
      // mapTypeScriptType("object") = DataDictionary. Then `[first]` (an
      // array literal whose element wrap reads `first`'s declared type)
      // emitted DataToken.__ctor__DataDictionary instead of __ctor__Int32.
      //
      // The negative assertion below is the load-bearing discriminator:
      // this exact source produces one __ctor__VRCSDK3DataDataDictionary
      // extern WITHOUT the parser scope fix and zero with it. Removing
      // either `const first = input[0]` (no inferType call) or the
      // `[first]` array literal wrap (no wrapDataToken consuming first's
      // type) collapses the test to a trivial pass.
      const source = `
        class Tile {
          constructor(public code: number) {}
        }
        class Holder {
          cached: Tile[];
          constructor(input: Tile[]) {
            const first = input[0];
            const arr: Tile[] = [first];
            this.cached = arr;
          }
        }
        class Main {
          Start(): void {
            const tiles: Tile[] = [];
            for (let i: number = 0; i < 3; i++) {
              tiles.push(new Tile(i));
            }
            const h = new Holder(tiles);
            Debug.Log(h.cached[0].code);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__ctor__VRCSDK3DataDataDictionary__VRCSDK3DataDataToken",
      );
    });
  });

  describe("as string cast extern coverage", () => {
    it("should emit Convert.ToString for int-as-string assertions", () => {
      const source = `
        import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
        class Main {
          Start(): void {
            const n: UdonInt = 42 as UdonInt;
            const s = n as string;
            Debug.Log(s);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).toContain(
        "SystemConvert.__ToString__SystemInt32__SystemString",
      );
    });

    it("should not emit Transform-specific Convert.ToString extern for type assertions", () => {
      const source = `
        class Main {
          Start(): void {
            const t: Transform = null as unknown as Transform;
            const s = t as string;
            Debug.Log(s);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      expect(result.uasm).not.toContain(
        "SystemConvert.__ToString__UnityEngineTransform__SystemString",
      );
    });
  });
});

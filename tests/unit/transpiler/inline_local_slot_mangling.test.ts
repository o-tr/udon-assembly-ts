/**
 * Scope-aware heap slot mangling for inlined locals.
 *
 * Two distinct methods that each declare a local with the same name but a
 * different Udon type must not share a heap slot when both are inlined into
 * the same caller — otherwise one of the two writes corrupts the slot's
 * declared type and triggers HeapTypeMismatchException at runtime.
 *
 * See issues/2026-05-09T020000-scope-aware-heap-slot-mangling.md
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

function extractDataSection(uasm: string): string {
  const start = uasm.indexOf(".data_start");
  const end = uasm.indexOf(".data_end");
  if (start < 0 || end < 0) return "";
  return uasm.slice(start, end);
}

/**
 * Parse `slotName: %TypeName, ...` declarations out of the data section.
 * Returns an array of {name, type} pairs in declaration order.
 */
function parseDataSlots(dataSection: string): { name: string; type: string }[] {
  const slots: { name: string; type: string }[] = [];
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*%([A-Za-z0-9_.]+)/gm;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
  while ((m = re.exec(dataSection)) !== null) {
    slots.push({ name: m[1], type: m[2] });
  }
  return slots;
}

describe("scope-aware heap slot mangling for inlined locals", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("allocates distinct heap slots when two inlined methods declare a same-named local of different types", () => {
    // Two static methods each declare `let c`:
    //   - asInt: c is SystemInt32
    //   - asString: c is SystemString
    // Both are inlined into Main.Start. Without scope-aware mangling, both
    // produce a single heap slot named `c` and the second declaration's type
    // overwrites the first, corrupting it.
    const source = `
      class Helper {
        static asInt(x: number): number {
          let c: number = x + 1;
          return c;
        }
        static asString(s: string): string {
          let c: string = s + "!";
          return c;
        }
      }
      class Main {
        Start(): void {
          let a: number = Helper.asInt(5);
          let b: string = Helper.asString("hi");
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const data = extractDataSection(result.uasm);
    const slots = parseDataSlots(data);

    // Heuristic: any slot whose name is exactly "c" or ends in "_c" is a
    // candidate for the inlined `c` local. Both inline expansions must each
    // produce their own slot — i.e. there must be a numeric slot
    // (SystemDouble — TS `number` → Udon Double) and a SystemString slot
    // both holding (some flavor of) `c`.
    const cLikeSlots = slots.filter(
      (s) => s.name === "c" || /(^|_)c$/.test(s.name),
    );

    const numericSlots = cLikeSlots.filter(
      (s) => s.type === "SystemDouble" || s.type === "SystemInt32",
    );
    const stringSlots = cLikeSlots.filter((s) => s.type === "SystemString");

    expect(numericSlots.length).toBeGreaterThanOrEqual(1);
    expect(stringSlots.length).toBeGreaterThanOrEqual(1);

    // The two slots must be different physical slots; otherwise the type of
    // one of the two declarations is being silently reused for the other.
    const numericSlotName = numericSlots[0]?.name;
    const stringSlotName = stringSlots[0]?.name;
    expect(numericSlotName).toBeDefined();
    expect(stringSlotName).toBeDefined();
    expect(numericSlotName).not.toBe(stringSlotName);
  });

  it("does not share a single `c` slot across two inlined methods with different element types", () => {
    // Tighter form of the original Tile.fromCode / Tile.pickThird scenario:
    // - fromCode has a numeric `c`
    // - pickThird has a Tile (object) `c` from an array element
    // Even when no caller declares `c`, the two inline expansions must not
    // collide in the data section.
    const source = `
      class Tile {
        code: number = 0;
        static fromCode(code: number): Tile {
          const c = code;
          return new Tile();
        }
        static pickThird(tiles: Tile[]): Tile {
          let c = tiles[2];
          return c;
        }
      }
      class Main {
        Start(): void {
          let a: Tile = Tile.fromCode(5);
          let arr: Tile[] = [a, a, a];
          let b: Tile = Tile.pickThird(arr);
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const data = extractDataSection(result.uasm);
    const slots = parseDataSlots(data);

    // There must NOT be exactly one slot named `c` covering both bodies.
    // After the fix, the two inlined `c`s live under distinct mangled names
    // (e.g. __inline_Tile_fromCode_c and __inline_Tile_pickThird_c), with
    // independent types.
    const exactlyC = slots.filter((s) => s.name === "c");
    expect(exactlyC.length).toBeLessThanOrEqual(1);

    // And there must be at least two distinct slots that look like the
    // inlined `c` (one numeric flavor, one Tile/object flavor).
    const cLikeSlots = slots.filter(
      (s) => s.name === "c" || /(^|_)c$/.test(s.name),
    );
    const distinctNames = new Set(cLikeSlots.map((s) => s.name));
    expect(distinctNames.size).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Minimal reproduction tests for remaining inline class bugs.
 *
 * Bug 1: Loop inline instance sharing — instances created in a loop
 *         share the same heap variables, so all handles point to the
 *         same (last-written) storage.
 *
 * Bug 2: super() constructor parameter property propagation — calling
 *         super(arg) does not assign the argument to the inherited
 *         parameter-property field.
 *
 * Bug 3: D3 method dispatch for inherited methods — when a child-class
 *         instance is stored in a collection and retrieved by index,
 *         methods inherited from the base class are not dispatched via
 *         D3 and fall back to invalid SystemObject EXTERNs.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("inline remaining bugs", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("coerces reference operands before logical not", () => {
    const source = `
      class Main {
        Start(): void {
          const values: number[] = [];
          if (!values) {
            Debug.Log("empty");
          } else {
            Debug.Log("present");
          }
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).toContain(
      "SystemObject.__op_Inequality__SystemObject_SystemObject__SystemBoolean",
    );
    expect(result.uasm).not.toMatch(
      /PUSH, values\n\s+PUSH, __tcoerce_\d+\n\s+COPY/,
    );
  });

  it("preserves structural union type through optional property access", () => {
    const source = `
      type Win = { isWin: true; yaku: string[] };
      type Lose = { isWin: false };
      type Result = Win | Lose;

      class Analyzer {
        check(): Result | null {
          return { isWin: true, yaku: [] };
        }
      }

      class Main {
        Start(): void {
          const analyzer = new Analyzer();
          const result = analyzer.check();
          if (result?.isWin) {
            Debug.Log("WIN");
          }
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).not.toContain(
      "SystemObject.__get_isWin__SystemBoolean",
    );
    expect(result.uasm).toContain("_isWin");
  });

  it("routes optional interface method calls through inline dispatch", () => {
    const source = `
      type CheckContext = { value: number };
      type CheckResult = { isValid: boolean };
      type Checker = {
        check(context: CheckContext): CheckResult;
      };

      class AlwaysValid {
        check(_context: CheckContext): CheckResult {
          return { isValid: true };
        }
      }

      class Registry {
        get(_name: string): Checker | null {
          return new AlwaysValid();
        }
      }

      class Main {
        Start(): void {
          const registry = new Registry();
          const checker = registry.get("x");
          const ok = checker?.check({ value: 1 }).isValid;
          if (ok) Debug.Log("OK");
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).not.toContain("SystemObject.__check__SystemObject");
    expect(result.uasm).toContain("_isValid");
  });

  it("unwraps anonymous structural array elements as inline handles", () => {
    const source = `
      type IYaku = {
        getDisplayName(): string;
      };

      class BaseYaku implements IYaku {
        getDisplayName(): string {
          return "Base";
        }
      }

      class TanyaoYaku extends BaseYaku {
        getDisplayName(): string {
          return "Tanyao";
        }
      }

      class Main {
        Start(): void {
          const yaku: IYaku = new TanyaoYaku();
          const found: Array<{ yaku: IYaku; name: string; han: number }> = [];
          found.push({ yaku, name: "Tanyao", han: 1 });
          for (const item of found) {
            Debug.Log(item.yaku.getDisplayName());
            Debug.Log(item.name);
            Debug.Log(item.han);
          }
        }
      }
    `;

    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).toContain(
      "VRCSDK3DataDataToken.__get_Int__SystemInt32",
    );
    expect(result.uasm).not.toContain(
      "VRCSDK3DataDataToken.__get_Reference__SystemObject",
    );
    expect(result.uasm).not.toContain("SystemObject.__getDisplayName");
  });

  // ---------------------------------------------------------------------------
  // Bug 1: Loop inline instance sharing
  // ---------------------------------------------------------------------------

  describe("loop inline instance sharing", () => {
    it("each loop iteration should allocate distinct storage for inline instances", () => {
      const source = `
          class Item {
            public id: number;
            constructor(id: number) {
              this.id = id;
            }
          }
          class Main {
            Start(): void {
              const items: Item[] = [];
              for (let i: number = 0; i < 3; i++) {
                items.push(new Item(i));
              }
              Debug.Log(items[0].id);
              Debug.Log(items[1].id);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // With SoA, the handle is assigned from a dynamic counter variable,
      // not a hardcoded constant. Verify the handle is not a static integer.
      const handleAssignments = result.tac
        .split("\n")
        .filter((l) => l.includes("__handle = "));

      expect(handleAssignments.length).toBeGreaterThan(0);
      for (const line of handleAssignments) {
        const rhs = line.slice(line.indexOf("=") + 1).trim();
        // A pure integer literal means all handles are the same (bug)
        expect(rhs).not.toMatch(/^\d+$/);
      }

      // SoA counter should exist and be incremented in the loop
      expect(result.tac).toContain("__soa_Item__counter");

      // Runtime init guard must exist so DataList init is not repeated per iteration
      expect(result.tac).toContain("__soa_Item__inited");
    });

    it("items pushed in a loop should retain their own field values", () => {
      const source = `
          class Item {
            public id: number;
            constructor(id: number) {
              this.id = id;
            }
          }
          class Main {
            Start(): void {
              const items: Item[] = [];
              for (let i: number = 0; i < 3; i++) {
                items.push(new Item(i));
              }
              Debug.Log(items[0].id);
              Debug.Log(items[1].id);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // SoA dispatch: field reads go through DataList.get_Item on the
      // per-field DataList, indexed by the dynamic handle value.
      // This ensures items[0].id and items[1].id read from different indices.
      expect(result.tac).toContain("__soa_Item_id");
      expect(result.tac).toContain("get_Item");
    });

    it("flyweight pattern: loop-created instances with distinct constructor args must not alias", () => {
      const source = `
          class Tile {
            public kind: number;
            public code: number;
            constructor(kind: number, code: number) {
              this.kind = kind;
              this.code = code;
            }
          }
          class Main {
            Start(): void {
              const tiles: Tile[] = [];
              for (let k: number = 0; k < 3; k++) {
                for (let c: number = 0; c < 9; c++) {
                  tiles.push(new Tile(k, k * 9 + c));
                }
              }
              // First tile should be kind=0,code=0; second kind=0,code=1
              Debug.Log(tiles[0].kind);
              Debug.Log(tiles[0].code);
              Debug.Log(tiles[1].code);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // SoA: per-field DataLists should exist for Tile class in the UASM data section.
      // Explicitly check for both field DataLists (not counter/inited vars).
      expect(result.uasm).toContain("__soa_Tile_kind:");
      expect(result.uasm).toContain("__soa_Tile_code:");

      // SoA counter and runtime guard flag should be present
      expect(result.uasm).toContain("__soa_Tile__counter");
      expect(result.uasm).toContain("__soa_Tile__inited");
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 2: super() constructor parameter property propagation
  // ---------------------------------------------------------------------------

  describe("super() constructor field propagation", () => {
    it("super(arg) should assign arg to inherited parameter-property field", () => {
      const source = `
          class Base {
            constructor(public name: string) {}
          }
          class Child extends Base {
            constructor(name: string) { super(name); }
          }
          class Main {
            Start(): void {
              const c = new Child("hello");
              Debug.Log(c.name);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const tac = result.tac;

      // The TAC must assign the constructor argument to the instance field.
      // Correct: __inst_Child_0_name = name  (or = "hello")
      // Buggy:   only "name = name" self-assignment, field never written
      expect(tac).toMatch(/__inst_Child_\d+_name = /);
    });

    it("super() with multiple parameter properties propagates all fields", () => {
      const source = `
          class Base {
            constructor(public x: number, public y: number) {}
          }
          class Child extends Base {
            constructor(x: number, y: number) { super(x, y); }
          }
          class Main {
            Start(): void {
              const c = new Child(10, 20);
              Debug.Log(c.x);
              Debug.Log(c.y);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const tac = result.tac;

      // Both fields must be assigned from the constructor arguments
      expect(tac).toMatch(/__inst_Child_\d+_x = /);
      expect(tac).toMatch(/__inst_Child_\d+_y = /);
    });
  });

  // ---------------------------------------------------------------------------
  // Bug 3: D3 dispatch for inherited methods
  // ---------------------------------------------------------------------------

  describe("D3 dispatch for inherited methods", () => {
    it("indexed access on child instances should D3-dispatch inherited methods", () => {
      const source = `
          class Base {
            constructor(public name: string) {}
            greet(): string { return "Hello " + this.name; }
          }
          class Child extends Base {
            constructor(name: string) { super(name); }
          }
          class Main {
            Start(): void {
              const items: Base[] = [];
              items.push(new Child("A"));
              items.push(new Child("B"));
              Debug.Log(items[0].greet());
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // Must NOT generate a SystemObject.__greet__ EXTERN
      expect(result.uasm).not.toContain("SystemObject.__greet__");

      // Verify handle-based dispatch: the TAC should contain a handle
      // comparison (e.g. "t9 == 1") to select the correct inline instance.
      const tac = result.tac;
      expect(tac).toMatch(/== \d+/);
    });

    it("for-of loop on child instances should D3-dispatch inherited methods", () => {
      const source = `
          class Base {
            constructor(public name: string) {}
            describe(): string { return this.name; }
          }
          class Child extends Base {
            constructor(name: string) { super(name); }
          }
          class Main {
            Start(): void {
              const items: Base[] = [];
              items.push(new Child("X"));
              items.push(new Child("Y"));
              for (const item of items) {
                Debug.Log(item.describe());
              }
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // Must NOT generate a SystemObject.__describe__ EXTERN
      expect(result.uasm).not.toContain("SystemObject.__describe__");

      // Verify handle-based dispatch is present
      expect(result.tac).toMatch(/== \d+/);
    });

    it("polymorphic dispatch: base and child classes with overridden method", () => {
      const source = `
          class Animal {
            constructor(public name: string) {}
            speak(): string { return this.name; }
          }
          class Dog extends Animal {
            constructor(name: string) { super(name); }
            speak(): string { return this.name + " barks"; }
          }
          class Cat extends Animal {
            constructor(name: string) { super(name); }
            speak(): string { return this.name + " meows"; }
          }
          class Main {
            Start(): void {
              const animals: Animal[] = [];
              animals.push(new Dog("Rex"));
              animals.push(new Cat("Whiskers"));
              Debug.Log(animals[0].speak());
              Debug.Log(animals[1].speak());
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // Must NOT fall back to SystemObject EXTERNs
      expect(result.uasm).not.toContain("SystemObject.__speak__");

      // Verify handle-based dispatch is present
      expect(result.tac).toMatch(/== \d+/);
    });

    it("indexed access on child instances should dispatch inherited property access", () => {
      const source = `
          class Base {
            constructor(public name: string) {}
          }
          class Child extends Base {
            constructor(name: string) { super(name); }
          }
          class Main {
            Start(): void {
              const items: Base[] = [];
              items.push(new Child("A"));
              Debug.Log(items[0].name);
            }
          }
        `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);

      // Must NOT generate a SystemObject property access
      expect(result.uasm).not.toContain("SystemObject.__get_name__");

      // Verify the property is resolved to the inline instance's heap variable
      expect(result.tac).toContain("__inst_Child_0_name");
    });
  });

  // ---------------------------------------------------------------------------
  // Bug C: SoA tracked dispatch — handle not restored from receiver
  // When a tracked SoA instance (in inlineInstanceMap) is dispatched via the
  // tracked path, the code uses instanceInfo.prefix directly without copying
  // the receiver's handle value into ${prefix}__handle first.  Body-caching
  // causes multiple constructions to share a prefix, so the last construction
  // leaves a stale value in __handle.  A method call or property access through
  // a stored reference (e.g. Holder.r) then reads the wrong DataList slot.
  // ---------------------------------------------------------------------------
  describe("SoA tracked dispatch handle restore", () => {
    it("method call on tracked SoA instance restores handle before DataList read", () => {
      // r1 and r2 share the same body-cached prefix (__inst_Reg_0) because both
      // come from the same Reg.make() call site. After r2 construction,
      // __inst_Reg_0__handle = 2. Without the fix, r1.get() uses handle 2 and
      // reads the wrong DataList slot. With the fix, a COPY restores handle 1
      // from r1 before entering the inlined get() body.
      const source = `
        class Reg {
          value: number;
          constructor(v: number) { this.value = v; }
          static make(v: number): Reg { return new Reg(v); }
          get(): number { return this.value; }
        }
        class Main {
          Start(): void {
            for (let i: number = 0; i < 1; i++) {
              const r1 = Reg.make(10);
              const r2 = Reg.make(20);
              Debug.Log(r1.get());
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const lines = result.tac.split("\n");

      // SoA must be triggered (Reg constructed in loop).
      expect(result.uasm).toContain("__soa_Reg_value:");

      const handleAssignIndexes = lines
        .map((line, idx) => (/__inst_\w+__handle = /.test(line) ? idx : -1))
        .filter((idx) => idx >= 0);
      const counterAssignIndexes = lines
        .map((line, idx) =>
          line.includes("__soa_Reg__counter") && line.includes("=") ? idx : -1,
        )
        .filter((idx) => idx >= 0);
      const getItemIndex = lines.findIndex(
        (line) => line.includes("__soa_Reg_value") && line.includes("get_Item"),
      );

      const restoreIndexes = lines
        .map((line, idx) =>
          /__inst_\w+__handle = /.test(line) &&
          !line.includes("__counter") &&
          !line.includes("__soa_mdisp")
            ? idx
            : -1,
        )
        .filter((idx) => idx >= 0);
      const secondConstructionIndex =
        counterAssignIndexes.length >= 2 ? counterAssignIndexes[1] : -1;
      const hasRestoreBetweenConstructionAndRead = restoreIndexes.some((idx) =>
        secondConstructionIndex >= 0 && getItemIndex >= 0
          ? idx > secondConstructionIndex && idx < getItemIndex
          : false,
      );

      expect(handleAssignIndexes.length).toBeGreaterThanOrEqual(3);
      expect(hasRestoreBetweenConstructionAndRead).toBe(true);
    });

    it("direct property access on tracked SoA instance restores handle", () => {
      // Same body-caching scenario as above, but accessed via property access
      // (expression.ts tracked path) rather than method call (call.ts tracked path).
      const source = `
        class Reg {
          value: number;
          constructor(v: number) { this.value = v; }
          static make(v: number): Reg { return new Reg(v); }
        }
        class Main {
          Start(): void {
            for (let i: number = 0; i < 1; i++) {
              const r1 = Reg.make(10);
              const r2 = Reg.make(20);
              Debug.Log(r1.value);
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const lines = result.tac.split("\n");

      expect(result.uasm).toContain("__soa_Reg_value:");

      // DataList read must be present (SoA field access path taken).
      const soaRead = lines.some(
        (l) => l.includes("__soa_Reg_value") && l.includes("get_Item"),
      );
      expect(soaRead).toBe(true);

      const getItemIndex = lines.findIndex(
        (line) => line.includes("__soa_Reg_value") && line.includes("get_Item"),
      );
      const counterAssignIndexes = lines
        .map((line, idx) =>
          line.includes("__soa_Reg__counter") && line.includes("=") ? idx : -1,
        )
        .filter((idx) => idx >= 0);
      const secondConstructionIndex =
        counterAssignIndexes.length >= 2 ? counterAssignIndexes[1] : -1;
      const restoreIndexes = lines
        .map((line, idx) =>
          /__inst_\w+__handle = /.test(line) &&
          !line.includes("__counter") &&
          !line.includes("__soa_mdisp")
            ? idx
            : -1,
        )
        .filter((idx) => idx >= 0);
      const hasRestoreBeforeRead = restoreIndexes.some((idx) =>
        secondConstructionIndex >= 0
          ? idx > secondConstructionIndex && idx < getItemIndex
          : idx < getItemIndex,
      );
      expect(hasRestoreBeforeRead).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Bug B: SoA field reads in inlined method bodies must use DataList, not scratch
  // When multiple SoA instances are created (construction inside a loop triggers
  // SoA), the scratch variable is reused on each construction. A field read on
  // an instance via an inlined method must go through the per-field DataList
  // indexed by the instance handle, not the scratch which holds only the
  // most-recently-constructed instance's data.
  // ---------------------------------------------------------------------------
  describe("SoA DataDictionary field read in inlined method body", () => {
    it("this.field inside inlined method uses DataList, not scratch variable", () => {
      // Two registries are built from the same static factory in the same scope.
      // Body-caching means both share the same instance prefix (__inst_Registry_0).
      // After reg2 is constructed, __inst_Registry_0__handle holds reg2's index,
      // making the scratch variable stale for reg1. The inlined getResult() body
      // must therefore read this.data through the per-field DataList indexed by
      // the restored handle, not via the (now-stale) scratch variable.
      const source = `
        class Registry {
          public data: DataDictionary;
          constructor() {
            this.data = new DataDictionary();
          }
          static build(): Registry {
            return new Registry();
          }
          getResult(key: DataToken): DataToken {
            return this.data.get_Item(key);
          }
        }
        class Main {
          Start(): void {
            for (let i: number = 0; i < 1; i++) {
              const reg1 = Registry.build();
              const reg2 = Registry.build();
              Debug.Log(reg1.getResult(new DataToken("key")));
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      // Registry must be treated as SoA (constructed inside the loop)
      expect(result.uasm).toContain("__soa_Registry_data:");
      // The inlined getResult() body must emit a DataList read for this.data,
      // not a bare PUSH of __inst_Registry_N_data (the scratch variable).
      expect(result.tac).toContain("__soa_Registry_data");
      // The TAC must contain the bounded DataList.get_Item pattern emitted by
      // emitBoundedDataListGetItem for the field read.
      const lines = result.tac.split("\n");
      const soaFieldRead = lines.filter(
        (l) => l.includes("__soa_Registry_data") && l.includes("get_Item"),
      );
      expect(soaFieldRead.length).toBeGreaterThan(0);
    });

    it("writes back a mutable Map field after SoA method dispatch mutates it", () => {
      const source = `
        interface IThing {
          name: string;
        }
        class Thing implements IThing {
          public name: string = "A";
        }
        class Registry {
          public data: Map<string, IThing>;
          constructor() {
            this.data = new Map<string, IThing>();
          }
          add(value: IThing): void {
            this.data.set(value.name, value);
          }
          get(name: string): IThing | null {
            return this.data.get(name) ?? null;
          }
        }
        class Main {
          Start(): void {
            const registries: Registry[] = [];
            for (let i: number = 0; i < 1; i++) {
              registries.push(new Registry());
            }
            const registry = registries[0];
            registry.add(new Thing());
            const result = registry.get("A");
            if (result) {
              Debug.Log(result.name);
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toContain("__soa_Registry_data:");

      const lines = result.tac.split("\n");
      const mutationIndex = lines.findIndex((line) =>
        /call __soa_mdisp_Registry_\d+_data\.SetValue\(/.test(line),
      );
      expect(mutationIndex).toBeGreaterThanOrEqual(0);

      const writeBackIndex = lines.findIndex(
        (line, index) =>
          index > mutationIndex &&
          line.includes("call __soa_Registry_data.set_Item("),
      );
      expect(writeBackIndex).toBeGreaterThan(mutationIndex);
    });

    it("guards inline-handle Map.get with ContainsKey before unwrapping Int", () => {
      const source = `
        interface IThing {
          name: string;
        }
        class Thing implements IThing {
          public name: string = "A";
        }
        class Registry {
          public data: Map<string, IThing> = new Map<string, IThing>();
          get(name: string): IThing | null {
            return this.data.get(name) ?? null;
          }
        }
        class Main {
          Start(): void {
            const registry = new Registry();
            const thing = new Thing();
            const result = registry.get("missing");
            if (result !== null) {
              Debug.Log(result.name);
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const lines = result.tac.split("\n");
      const containsKeyIndex = lines.findIndex((line) =>
        line.includes(".ContainsKey("),
      );
      const getValueIndex = lines.findIndex((line) =>
        line.includes(".GetValue("),
      );
      expect(containsKeyIndex).toBeGreaterThanOrEqual(0);
      expect(getValueIndex).toBeGreaterThan(containsKeyIndex);
    });

    it("unwraps Map.get DataToken to DataList inside nullish coalescing", () => {
      const source = `
        class Registry {
          public byCategory: Map<string, number[]> = new Map<string, number[]>();
          getByCategory(category: string): number[] {
            return this.byCategory.get(category) ?? [];
          }
        }
        class Main {
          Start(): void {
            const registry = new Registry();
            const values = registry.getByCategory("missing");
            Debug.Log(values.length);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toContain("VRCSDK3DataDataToken.__get_DataList");
      expect(result.tac).not.toMatch(/__inline_ret_\d+ = __t\d+$/m);
    });

    it("uses the fallback DataList type for Map.get nullish coalescing without contextual return type", () => {
      const source = `
        class Main {
          Start(): void {
            const byCategory: Map<string, number[]> = new Map<string, number[]>();
            const values = byCategory.get("missing") ?? [];
            Debug.Log(values.length);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.tac).toContain(".DataList");
      expect(result.tac).not.toMatch(/ = __t\d+$/m);
    });
  });

  describe("SoA multi-class handle collision", () => {
    it("two SoA classes via shared interface must have non-overlapping handles", () => {
      // Alpha and Beta each implement IValue and are constructed in loops.
      // Before the fix both classes used per-class counters starting at 1,
      // so Alpha instance N and Beta instance N got the same handle value.
      // The dispatch loop would always match the first candidate (Alpha),
      // returning Alpha fields regardless of which class the receiver was.
      const source = `
        interface IValue {
          getValue(): number;
        }
        class Alpha implements IValue {
          x: number;
          constructor(x: number) { this.x = x; }
          getValue(): number { return this.x; }
        }
        class Beta implements IValue {
          y: number;
          constructor(y: number) { this.y = y; }
          getValue(): number { return this.y; }
        }
        class Main {
          Start(): void {
            const values: IValue[] = [];
            for (let i: number = 0; i < 3; i++) {
              values.push(new Alpha(i));
              values.push(new Beta(i + 10));
            }
            Debug.Log(values[0].getValue());
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      const tac = result.tac;

      // Both classes must be SoA (constructed in a loop → per-field DataLists).
      expect(tac).toContain("__soa_Alpha_x");
      expect(tac).toContain("__soa_Beta_y");

      // Alpha is class 0 (offset=0) so its counter starts at 1 — unchanged.
      // Beta is class 1 (offset=SOA_PARTITION_SIZE=1048576) so its counter
      // starts at 1048577.  The TAC init block must assign that value.
      expect(tac).toMatch(/__soa_Beta__counter = 1048577\b/);

      // The handles must not overlap: a subtraction must be emitted before
      // Beta's DataList is accessed (the index = handle - offset pattern).
      // We verify by checking the TAC contains "- 1048576" somewhere.
      expect(tac).toContain("- 1048576");
    });
  });
});

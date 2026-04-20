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
  // Bug B: SoA field reads in inlined method bodies must use DataList, not scratch
  // When multiple SoA instances are created (construction inside a loop triggers
  // SoA), the scratch variable is reused on each construction. A field read on
  // an instance via an inlined method must go through the per-field DataList
  // indexed by the instance handle, not the scratch which holds only the
  // most-recently-constructed instance's data.
  // ---------------------------------------------------------------------------
  describe("SoA DataDictionary field read in inlined method body", () => {
    it("this.field inside inlined method uses DataList, not scratch variable", () => {
      // Registry is constructed inside a loop → SoA. The `data` field DataList
      // is __soa_Registry_data. After multiple iterations, reading this.data
      // inside getResult() must go through DataList[handle], not the scratch.
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
            for (let i: number = 0; i < 3; i++) {
              const reg = Registry.build();
              Debug.Log(reg.getResult(new DataToken("key")));
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
  });
});

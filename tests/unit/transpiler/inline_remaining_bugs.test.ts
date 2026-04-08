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
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("inline remaining bugs", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  // ---------------------------------------------------------------------------
  // Bug 1: Loop inline instance sharing
  // ---------------------------------------------------------------------------

  describe("loop inline instance sharing", () => {
    it.fails(
      "each loop iteration should allocate distinct storage for inline instances",
      () => {
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

        // The loop body must NOT reuse the same handle value for every iteration.
        // Currently __inst_Item_0__handle is always 1, so all items share storage.
        const handleAssignments = result.tac
          .split("\n")
          .filter((l) => l.includes("__handle = "));

        // There should be multiple distinct handle values (one per iteration),
        // or a dynamic counter. A single hardcoded "= 1" means all share storage.
        const uniqueValues = new Set(
          handleAssignments.map((l) => l.split("=")[1]?.trim()),
        );
        expect(uniqueValues.size).toBeGreaterThan(1);
      },
    );

    it.fails(
      "items pushed in a loop should retain their own field values",
      () => {
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

        // When reading items[0].id and items[1].id the D3 dispatch branches
        // should resolve to DIFFERENT heap variables (or use SoA get_Item).
        // Currently both resolve to __inst_Item_0_id which holds the last value.
        const d3Reads = result.tac
          .split("\n")
          .filter(
            (l) =>
              l.includes("__uninst_prop_") && l.includes("__inst_Item_"),
          );

        // Collect the source variables being read in D3 dispatch
        const sources = d3Reads.map((l) => l.split("=")[1]?.trim());
        const uniqueSources = new Set(sources);

        // items[0].id and items[1].id should read from different storage
        expect(uniqueSources.size).toBeGreaterThan(1);
      },
    );

    it.fails(
      "flyweight pattern: loop-created instances with distinct constructor args must not alias",
      () => {
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

        // Each loop iteration's Tile must have independent field storage.
        // Count distinct instance prefixes allocated inside the loop body.
        const instVars = result.uasm
          .split("\n")
          .filter(
            (l) =>
              l.includes("__inst_Tile_") &&
              l.includes(":") &&
              l.includes("%"),
          )
          .map((l) => l.trim().split(":")[0]);

        // With 27 tiles we need 27 × 2 fields + 27 handles = 81 variables,
        // or SoA DataLists. A single set (kind + code + handle = 3 vars) means aliasing.
        const prefixes = new Set(
          instVars.map((v) => v.replace(/_kind$|_code$|__handle$/, "")),
        );
        expect(prefixes.size).toBeGreaterThan(1);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Bug 2: super() constructor parameter property propagation
  // ---------------------------------------------------------------------------

  describe("super() constructor field propagation", () => {
    it.fails(
      "super(arg) should assign arg to inherited parameter-property field",
      () => {
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
        // Buggy:   name = name                 (self-assignment, field never written)
        expect(tac).toMatch(/__inst_Child_\d+_name = /);

        // The self-assignment "name = name" should NOT be present
        // (it means the super() body assigned to the parameter variable, not the field).
        const selfAssigns = tac
          .split("\n")
          .filter((l) => {
            const m = l.match(/^\s*(\w+)\s*=\s*(\w+)\s*$/);
            return m && m[1] === m[2] && m[1] === "name";
          });
        expect(selfAssigns).toHaveLength(0);
      },
    );

    it.fails(
      "super() with multiple parameter properties propagates all fields",
      () => {
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
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Bug 3: D3 dispatch for inherited methods
  // ---------------------------------------------------------------------------

  describe("D3 dispatch for inherited methods", () => {
    it.fails(
      "indexed access on child instances should D3-dispatch inherited methods",
      () => {
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

        // The D3 method dispatch should inline the method body for each candidate
        const tac = result.tac;
        expect(tac).toContain("d3_method");
      },
    );

    it.fails(
      "for-of loop on child instances should D3-dispatch inherited methods",
      () => {
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
      },
    );

    it.fails(
      "polymorphic dispatch: base and child classes with overridden method",
      () => {
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

        // Should have D3 dispatch branches for both Dog and Cat
        const tac = result.tac;
        const hasDogBranch = tac.includes("__inst_Dog_");
        const hasCatBranch = tac.includes("__inst_Cat_");
        expect(hasDogBranch).toBe(true);
        expect(hasCatBranch).toBe(true);
      },
    );
  });
});

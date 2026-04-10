import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("string / for-of / null-check regressions", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  describe("Bug 1: string method/property return types resolve to SystemObject", () => {
    it("indexOf() without annotation does not produce SystemObject comparison", () => {
      const source = `
        class Main {
          Start(): void {
            const s: string = "mps";
            const ch: string = "m";
            const idx = s.indexOf(ch);
            if (idx < 0) { Debug.Log("nf"); }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toBeDefined();
      expect(result.uasm).not.toContain(
        "SystemObject.__op_LessThan__SystemObject_SystemObject__SystemBoolean",
      );
    });

    it("toUpperCase() without annotation resolves to SystemString", () => {
      const source = `
        class Main {
          Start(): void {
            const s: string = "hello";
            const u = s.toUpperCase();
            Debug.Log(u);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toBeDefined();
      expect(result.uasm).toMatch(/\bu: %SystemString/);
    });

    it("string.length without annotation does not produce SystemObject comparison", () => {
      const source = `
        class Main {
          Start(): void {
            const s: string = "hello";
            const len = s.length;
            if (len > 3) { Debug.Log("long"); }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toBeDefined();
      expect(result.uasm).not.toContain(
        "SystemObject.__op_GreaterThan__SystemObject_SystemObject__SystemBoolean",
      );
    });

    it("startsWith() without annotation resolves to SystemBoolean", () => {
      const source = `
        class Main {
          Start(): void {
            const s: string = "hello";
            const b = s.startsWith("he");
            if (b) { Debug.Log("yes"); }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toBeDefined();
      expect(result.uasm).toMatch(/\bb: %SystemBoolean/);
    });

    it("idx annotated as number avoids SystemObject op_LessThan despite inferred call-site temp", () => {
      const source = `
        class Main {
          Start(): void {
            const s: string = "mps";
            const ch: string = "m";
            const idx: number = s.indexOf(ch);
            if (idx < 0) { Debug.Log("nf"); }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toBeDefined();
      expect(result.uasm).not.toContain(
        "SystemObject.__op_LessThan__SystemObject_SystemObject__SystemBoolean",
      );
    });

    it("extern signatures themselves are correct for string methods", () => {
      const source = `
        class Main {
          Start(): void {
            const s: string = "hello";
            const idx = s.indexOf("l");
            const len = s.length;
            const u = s.toUpperCase();
            Debug.Log(idx);
            Debug.Log(len);
            Debug.Log(u);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toContain(
        "SystemString.__IndexOf__SystemString__SystemInt32",
      );
      expect(result.uasm).toContain("SystemString.__get_Length__SystemInt32");
      expect(result.uasm).toContain("SystemString.__ToUpper__SystemString");
    });
  });

  describe("Bug 2: inferred array for-of uses DataToken.get_Reference", () => {
    it.fails("string array literal for-of uses get_Reference", () => {
      const source = `
        class Main {
          Start(): void {
            const names = ["alice", "bob"];
            for (const name of names) {
              Debug.Log(name);
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toBeDefined();
      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__get_Reference__SystemObject",
      );
    });

    it.fails("number array literal for-of uses get_Reference", () => {
      const source = `
        class Main {
          Start(): void {
            const nums = [10, 20, 30];
            let sum: number = 0;
            for (const n of nums) { sum = sum + n; }
            Debug.Log(sum);
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toBeDefined();
      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__get_Reference__SystemObject",
      );
    });

    it.fails("inline class method for-of uses get_Reference", () => {
      const source = `
        class Evaluator {
          build(): void {
            const names = ["Tanyao", "Pinfu", "Riichi"];
            for (const name of names) {
              Debug.Log(name);
            }
          }
        }
        class Main {
          Start(): void { new Evaluator().build(); }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toBeDefined();
      expect(result.uasm).not.toContain(
        "VRCSDK3DataDataToken.__get_Reference__SystemObject",
      );
    });

    it("explicit string[] for-of uses native array get", () => {
      const source = `
        class Main {
          Start(): void {
            const names: string[] = ["alice", "bob"];
            for (const name of names) {
              Debug.Log(name);
            }
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toContain(
        "SystemStringArray.__Get__SystemInt32__SystemString",
      );
      expect(result.uasm).not.toContain("VRCSDK3DataDataToken.__get_Reference");
    });
  });

  describe("Bug 3: nullable array null-check uses SystemArray comparison", () => {
    it("string[] | null !== null uses SystemObject.__op_Inequality", () => {
      const source = `
        class Main {
          private data: string[] | null = null;
          Start(): void {
            if (this.data !== null) { Debug.Log("has data"); }
            this.data = ["x"];
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toBeDefined();
      expect(result.uasm).not.toContain(
        "SystemArray.__op_Inequality__SystemArray_SystemArray__SystemBoolean",
      );
      expect(result.uasm).toContain(
        "SystemObject.__op_Inequality__SystemObject_SystemObject__SystemBoolean",
      );
    });

    it("number[] | null === null uses SystemObject.__op_Equality", () => {
      const source = `
        class Main {
          private counts: number[] | null = null;
          Start(): void {
            if (this.counts === null) { this.counts = [1, 2, 3]; }
            Debug.Log("done");
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toBeDefined();
      expect(result.uasm).not.toContain(
        "SystemArray.__op_Equality__SystemArray_SystemArray__SystemBoolean",
      );
      expect(result.uasm).toContain(
        "SystemObject.__op_Equality__SystemObject_SystemObject__SystemBoolean",
      );
    });

    it("static field flyweight pattern uses SystemObject.__op_Inequality", () => {
      const source = `
        class Cache {
          private static _items: string[] | null = null;
          static getItems(): string[] {
            if (Cache._items !== null) return Cache._items;
            Cache._items = ["a", "b", "c"];
            return Cache._items;
          }
        }
        class Main {
          Start(): void { Debug.Log(Cache.getItems().length); }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).toBeDefined();
      expect(result.uasm).not.toContain(
        "SystemArray.__op_Inequality__SystemArray_SystemArray__SystemBoolean",
      );
      expect(result.uasm).toContain(
        "SystemObject.__op_Inequality__SystemObject_SystemObject__SystemBoolean",
      );
    });

    it("Map | null does not use SystemArray comparison", () => {
      const source = `
        class Main {
          private cache: Map<string, number> | null = null;
          Start(): void {
            if (this.cache !== null) { Debug.Log("exists"); }
            this.cache = new Map<string, number>();
          }
        }
      `;
      const result = new TypeScriptToUdonTranspiler().transpile(source);
      expect(result.uasm).not.toContain("SystemArray.__op_Inequality");
      expect(result.uasm).not.toContain("SystemArray.__op_Equality");
      expect(result.uasm).toContain(
        "SystemObject.__op_Inequality__SystemObject_SystemObject__SystemBoolean",
      );
    });
  });
});

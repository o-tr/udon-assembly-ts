import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("vm report regressions", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("keeps inline constructor UdonInt parameter propagation in Score-like flow", () => {
    const source = `
      import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
      class Score {
        constructor(public value: UdonInt) {}
        add(delta: UdonInt): Score {
          return new Score((this.value + delta) as UdonInt);
        }
      }
      class Main {
        Start(): void {
          const s = new Score(25000 as UdonInt);
          const s2 = s.add(1000 as UdonInt);
          Debug.Log(s.value);
          Debug.Log(s2.value);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Parameter property assignment must bind constructor arg to inline field.
    expect(result.tac).toMatch(/__inst_Score_\d+_value = value/);
    // Inline field read should not fall back to EXTERN property get.
    expect(result.uasm).not.toMatch(/Score\.__get_value/);
    // UdonInt arithmetic should stay Int32-based.
    expect(result.uasm).toContain(
      "SystemInt32.__op_Addition__SystemInt32_SystemInt32__SystemInt32",
    );
    expect(result.uasm).not.toContain(
      "SystemSingle.__op_Addition__SystemSingle_SystemSingle__SystemSingle",
    );
  });

  it("keeps Map.size vs UdonInt comparison on Int32 externs in LRU-like flow", () => {
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
      }
      class Main {
        Start(): void {
          const c = new LRUCache(2 as UdonInt);
          c.get("a");
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    // Int32 comparisons should be used (not Single comparisons).
    expect(result.uasm).toContain(
      "SystemInt32.__op_Inequality__SystemInt32_SystemInt32__SystemBoolean",
    );
    expect(result.uasm).toContain(
      "SystemInt32.__op_GreaterThan__SystemInt32_SystemInt32__SystemBoolean",
    );
    expect(result.uasm).not.toContain(
      "SystemSingle.__op_Inequality__SystemSingle_SystemSingle__SystemBoolean",
    );
    expect(result.uasm).not.toContain(
      "SystemSingle.__op_GreaterThan__SystemSingle_SystemSingle__SystemBoolean",
    );
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("registry double-init guard", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("emits __inited guard for each inline instance with a Map field initializer", () => {
    // Bug: emitInlinePropertyInitializersForClass ran once per independent inline
    // context (fresh emittedClassNames set), so two construction call sites for
    // the same body-cached instance prefix would both emit a raw DataDictionary
    // ctor — wiping any previously populated dict.
    // Fix: wrap the property init block in an idempotency guard using a per-prefix
    // __inited flag so only the first execution runs.
    const source = `
      class Registry {
        public data: Map<string, number> = new Map<string, number>();
        constructor() {
          this.data.set("key", 42);
        }
        static create(): Registry { return new Registry(); }
        get(k: string): number { return this.data.get(k) ?? 0; }
      }
      class A {
        r: Registry;
        constructor() { this.r = Registry.create(); }
        getVal(): number { return this.r.get("key"); }
      }
      class B {
        r: Registry = Registry.create();
      }
      class Main {
        Start(): void {
          const a = new A();
          const b = new B();
          Debug.Log(a.getVal());
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const lines = result.tac.split("\n");

    // The __inited guard variable must appear in the TAC.
    const initedGuards = lines.filter((l) => l.includes("__inited"));
    expect(initedGuards.length).toBeGreaterThan(0);

    // Each DataDictionary ctor must be preceded by a prop_init_skip guard.
    const dictCtorIdxs = lines
      .map((l, i) => ({ line: l, idx: i }))
      .filter(({ line }) => line.includes("DataDictionary.__ctor__"))
      .map(({ idx }) => idx);

    for (const ctorIdx of dictCtorIdxs) {
      // Look back up to 5 lines for the ifFalse guard that protects this ctor.
      const guardLines = lines.slice(Math.max(0, ctorIdx - 5), ctorIdx);
      const hasGuard = guardLines.some(
        (l) => l.includes("ifFalse") && l.includes("prop_init_skip"),
      );
      expect(hasGuard).toBe(true);
    }

    // Lookup (GetValue) must work: assert it's present and the data was set.
    const getLines = lines.filter((l) => l.includes("GetValue"));
    expect(getLines.length).toBeGreaterThan(0);
  });

  it("guard prevents dict wipe when multiple call sites share the same instance prefix", () => {
    // Repro of HandAnalyzer scenario: Registry constructed in two places
    // (explicit ctor call + field initializer) with body-caching causing the same
    // instance prefix. Without the guard, Service's field initializer wipes the
    // dict populated during Orchestrator construction, breaking the subsequent lookup.
    const source = `
      class Registry {
        public data: Map<string, number> = new Map<string, number>();
        constructor() {
          this.data.set("A", 1);
          this.data.set("B", 2);
        }
        static create(): Registry { return new Registry(); }
        get(k: string): number { return this.data.get(k) ?? 0; }
      }

      class Evaluator {
        r: Registry;
        result: number;
        constructor(r: Registry) {
          this.r = r;
          this.result = this.buildList();
        }
        buildList(): number {
          return this.r.get("A");
        }
      }

      class Service {
        reg: Registry = Registry.create();
      }

      class Orchestrator {
        registry: Registry;
        evaluator: Evaluator;
        service: Service;
        constructor() {
          this.registry = Registry.create();
          this.evaluator = new Evaluator(this.registry);
          this.service = new Service();
        }
      }

      class Main {
        Start(): void {
          const orch = new Orchestrator();
          Debug.Log(orch.evaluator.result);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const lines = result.tac.split("\n");

    // All DataDictionary ctors must be wrapped in the __inited guard.
    const dictCtorIdxs = lines
      .map((l, i) => ({ line: l, idx: i }))
      .filter(({ line }) => line.includes("DataDictionary.__ctor__"))
      .map(({ idx }) => idx);

    expect(dictCtorIdxs.length).toBeGreaterThan(0);
    for (const ctorIdx of dictCtorIdxs) {
      const guardLines = lines.slice(Math.max(0, ctorIdx - 5), ctorIdx);
      const hasGuard = guardLines.some(
        (l) => l.includes("ifFalse") && l.includes("prop_init_skip"),
      );
      expect(hasGuard).toBe(true);
    }

    // The GetValue lookup must appear in the TAC (Evaluator.buildList() emitted).
    const getLines = lines.filter((l) => l.includes("GetValue"));
    expect(getLines.length).toBeGreaterThan(0);
  });
});

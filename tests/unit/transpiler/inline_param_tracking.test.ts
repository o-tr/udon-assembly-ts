/**
 * Tests for inline instance tracking across method call boundaries.
 *
 * When an inline instance (type alias object literal, inline class, or
 * interface-typed object literal) is passed as a parameter to an inlined
 * method, property access inside that method must resolve to the inline
 * heap variable directly, not emit an EXTERN call.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

/** Extract a TAC section by label pattern. */
function getTacSection(tac: string, labelPattern: RegExp): string {
  const lines = tac.split("\n");
  const startIdx = lines.findIndex((line) => labelPattern.test(line));
  if (startIdx < 0) return "";
  const endIdx = lines.findIndex(
    (line, i) => i > startIdx && line.trim().startsWith("return"),
  );
  return lines
    .slice(startIdx, endIdx !== -1 ? endIdx + 1 : undefined)
    .join("\n");
}

describe("inline instance tracking across method boundaries", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("tracks type alias object through inlined static method parameter", () => {
    const source = `
      type Config = { value: number; label: string };
      class Helper {
        static process(cfg: Config): number { return cfg.value; }
      }
      class Entry {
        Start(): void {
          let cfg: Config = { value: 42, label: "test" };
          let r: number = Helper.process(cfg);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getTacSection(result.tac, /_start:/);

    // Inline instance variables should be created
    expect(startSection).toMatch(/__inst_Config_\d+_value/);
    expect(startSection).toMatch(/__inst_Config_\d+_label/);

    // Property access inside the inlined method should resolve to
    // inline variables, not EXTERN calls
    expect(startSection).not.toMatch(/EXTERN.*Config/);
  });

  it("tracks inline class instance through inlined instance method parameter", () => {
    const source = `
      class Vec2 {
        x: number = 0;
        y: number = 0;
      }
      class MathHelper {
        static magnitude(v: Vec2): number { return v.x + v.y; }
      }
      class Entry {
        Start(): void {
          let v: Vec2 = new Vec2();
          v.x = 3;
          v.y = 4;
          let m: number = MathHelper.magnitude(v);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getTacSection(result.tac, /_start:/);

    // Instance variables should exist
    expect(startSection).toMatch(/__inst_Vec2_\d+_x/);
    expect(startSection).toMatch(/__inst_Vec2_\d+_y/);

    // No EXTERN for Vec2 property access
    expect(startSection).not.toMatch(/EXTERN.*Vec2/);
  });

  it("tracks type alias object through nested inlined method calls", () => {
    const source = `
      type Data = { value: number };
      class Inner {
        static read(d: Data): number { return d.value; }
      }
      class Outer {
        static process(d: Data): number { return Inner.read(d); }
      }
      class Entry {
        Start(): void {
          let d: Data = { value: 99 };
          let r: number = Outer.process(d);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getTacSection(result.tac, /_start:/);

    // Instance variable should exist
    expect(startSection).toMatch(/__inst_Data_\d+_value/);

    // No EXTERN for Data property access through nested calls
    expect(startSection).not.toMatch(/EXTERN.*Data/);
  });

  it("resolves property access on export-name-remapped parameter after inline reassignment", () => {
    // When an entry class implements an interface, its method parameters
    // get export names (e.g. "IWorker_run__param_0"). If such a parameter
    // is reassigned to an inline object, inlineInstanceMap stores the entry
    // under the export name. The pre-eval lookup (B2) must bridge the raw
    // AST name to the export name via currentParamExportMap.
    const source = `
      type Config = { value: number };
      interface IWorker {
        run(cfg: Config): number;
      }
      class Entry implements IWorker {
        run(cfg: Config): number {
          cfg = { value: 42 };
          return cfg.value;
        }
        Start(): void {
          let r: number = this.run({ value: 0 });
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // The interface method body gets its own TAC section
    const runSection = getTacSection(result.tac, /__run_Entry:/);

    // Inline instance variable should be created for the reassignment
    expect(runSection).toMatch(/__inst_Config_\d+_value/);

    // Property access on the remapped parameter should resolve to the
    // inline variable without EXTERN
    expect(runSection).not.toMatch(/EXTERN.*Config/);
  });

  it("forwards inline instance through export-name-remapped parameter to inlined method", () => {
    // When an entry class implements an interface, its method parameters
    // get export names. If such a parameter is reassigned to an inline
    // object and then passed to an inlined static method, the tracking
    // must propagate through saveAndBindInlineParams and the callee must
    // resolve the property without EXTERN.
    const source = `
      type Config = { value: number };
      interface IWorker {
        run(cfg: Config): number;
      }
      class Helper {
        static getVal(c: Config): number { return c.value; }
      }
      class Entry implements IWorker {
        run(cfg: Config): number {
          cfg = { value: 42 };
          return Helper.getVal(cfg);
        }
        Start(): void {
          let r: number = this.run({ value: 0 });
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const runSection = getTacSection(result.tac, /__run_Entry:/);

    // The inline instance should be created and its property resolved
    // inside the nested inlined Helper.getVal call
    expect(runSection).toMatch(/__inst_Config_\d+_value/);
    expect(runSection).not.toMatch(/EXTERN.*Config/);
  });

  it("resolves properties on interface-typed object literal (classRegistry fallback)", () => {
    const source = `
      interface IConfig {
        value: number;
        name: string;
      }
      class Entry {
        Start(): void {
          let cfg: IConfig = { value: 42, name: "test" };
          let v: number = cfg.value;
          let n: string = cfg.name;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getTacSection(result.tac, /_start:/);

    // Inline instance variables should be created for interface properties
    expect(startSection).toMatch(/__inst_IConfig_\d+_value/);
    expect(startSection).toMatch(/__inst_IConfig_\d+_name/);

    // Property access should resolve to inline variables, not EXTERN
    expect(startSection).not.toMatch(/EXTERN.*IConfig/);
  });

  it("auto-tracks type alias parameter by type fallback", () => {
    const source = `
      type Config = { x: number; y: number };
      class Helper {
        static sum(cfg: Config): number { return cfg.x + cfg.y; }
      }
      class Entry {
        Start(): void {
          const cfg: Config = { x: 10, y: 20 };
          Debug.Log(Helper.sum(cfg));
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getTacSection(result.tac, /_start:/);

    // Inline instance variables should be created for Config
    expect(startSection).toMatch(/__inst_Config_\d+_x/);
    expect(startSection).toMatch(/__inst_Config_\d+_y/);

    // No EXTERN for Config property access
    expect(result.uasm).not.toMatch(/Config\.__get_/);
  });

  it("auto-tracks inline class parameter by type fallback", () => {
    const source = `
      class Vec { x: number = 0; y: number = 0; }
      class Math2 {
        static length(v: Vec): number { return v.x + v.y; }
      }
      class Entry {
        Start(): void {
          const v = new Vec();
          v.x = 3; v.y = 4;
          Debug.Log(Math2.length(v));
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getTacSection(result.tac, /_start:/);

    // Inline instance variables should be created for Vec
    expect(startSection).toMatch(/__inst_Vec_\d+_x/);
    expect(startSection).toMatch(/__inst_Vec_\d+_y/);

    // No EXTERN for Vec property access
    expect(result.uasm).not.toMatch(/Vec\.__get_/);
  });

  it("tracks inline instance through return value copy chain", () => {
    const source = `
      type Result = { value: number; ok: boolean };
      class Calc {
        compute(): Result { return { value: 42, ok: true }; }
      }
      class Main {
        Start(): void {
          const c = new Calc();
          const r = c.compute();
          let v: number = r.value;
          let o: boolean = r.ok;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    expect(result.uasm).not.toMatch(/Result\.__get_/);
  });

  it("tracks inline instance parameter through copy", () => {
    const source = `
      type Config = { x: number; y: number };
      class Helper {
        static sum(cfg: Config): number { return cfg.x + cfg.y; }
      }
      class Main {
        Start(): void {
          const cfg: Config = { x: 10, y: 20 };
          let s: number = Helper.sum(cfg);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    expect(result.uasm).not.toMatch(/Config\.__get_/);
  });

  it("tracks class instance parameter through copy", () => {
    const source = `
      class Vec { x: number = 0; y: number = 0; }
      class Math2 {
        static len(v: Vec): number { return v.x + v.y; }
      }
      class Main {
        Start(): void {
          const v = new Vec(); v.x = 3; v.y = 4;
          let l: number = Math2.len(v);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    expect(result.uasm).not.toMatch(/Vec\.__get_/);
  });

  it("preserves tracking when branches return different inline instances of the same type", () => {
    // Different branches create different inline instances, but both are the
    // same interface type. Fields are copied to a stable per-call-site prefix
    // so the caller can still resolve properties without EXTERN.
    const source = `
      type Pair = { a: number; b: number };
      class Logic {
        static choose(flag: boolean): Pair {
          if (flag) { return { a: 1, b: 2 }; }
          return { a: 3, b: 4 };
        }
      }
      class Main {
        Start(): void {
          const p = Logic.choose(true);
          let x: number = p.a;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // Fields are copied to a unified return prefix — no EXTERN needed
    expect(result.uasm).not.toMatch(/Pair\.__get_/);
  });

  it("preserves tracking when single return path is used", () => {
    const source = `
      type Pair = { a: number; b: number };
      class Logic {
        static make(): Pair {
          const p: Pair = { a: 10, b: 20 };
          return p;
        }
      }
      class Main {
        Start(): void {
          const p = Logic.make();
          let x: number = p.a;
          let y: number = p.b;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // Single return path — tracking should propagate
    expect(result.uasm).not.toMatch(/Pair\.__get_/);
  });

  it("splits ternary return branches so each populates the unified return prefix", () => {
    // `return cond ? p1 : p2` in an inline method with a structural/interface
    // return type is split into per-branch returns. Each branch field-copies
    // into the unified return prefix, so the caller reads slots directly
    // without needing a runtime handle-dispatch.
    const source = `
      type Pt = { x: number };
      class A {
        static choose(flag: boolean): Pt {
          const p1: Pt = { x: 1 };
          const p2: Pt = { x: 2 };
          return flag ? p1 : p2;
        }
      }
      class Main {
        Start(): void {
          const r = A.choose(true);
          let v: number = r.x;
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    // No EXTERN property getter — inline slot access is used instead.
    expect(result.uasm).not.toMatch(/Pt\.__get_/);
    // Each of the two object-literal Pt instances must appear as a source
    // in a `_x` field-copy into the unified return prefix — the ternary
    // split must have produced one field-copy per branch.
    const copies = [
      ...result.tac.matchAll(/__inline_ret_\d+_x = (__inst_Pt_\d+)_x/g),
    ].map((m) => m[1]);
    expect(copies).toContain("__inst_Pt_0");
    expect(copies).toContain("__inst_Pt_1");
  });

  it("dispatches inline method call for temporary arg from Map.get", () => {
    // Temporary operands (Map.get(...)!) may not carry inlineInstanceMap keys.
    // The call should still inline via handle-based dispatch, not EXTERN.
    const source = `
      class Ctx {
        value: number = 1;
        inc(): number { return this.value + 1; }
      }
      class Helper {
        static read(c: Ctx): number { return c.inc(); }
      }
      class Main {
        private store: Map<string, Ctx> = new Map<string, Ctx>();
        Start(): void {
          this.store.set("k", new Ctx());
          const v = Helper.read(this.store.get("k")!);
          Debug.Log(v);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).not.toMatch(/SystemObject\.__inc__/);
    expect(result.uasm).not.toMatch(/Ctx\.__inc__/);
    expect(result.tac).toMatch(/__inst_Ctx_\d+_value/);
  });

  it("dispatches interface-typed untracked receiver from Map.get without extern fallback", () => {
    const source = `
      interface I {
        inc(): number;
      }
      class Ctx implements I {
        value: number = 1;
        inc(): number { return this.value + 1; }
      }
      class Helper {
        static read(c: I): number { return c.inc(); }
      }
      class Main {
        private store: Map<string, I> = new Map<string, I>();
        Start(): void {
          this.store.set("k", new Ctx());
          const v = Helper.read(this.store.get("k")!);
          Debug.Log(v);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).not.toMatch(/SystemObject\.__inc__/);
    expect(result.uasm).not.toMatch(/I\.__inc__/);
    expect(result.tac).toContain("untracked_call_next");
  });

  it("re-lowers object literal args with interface parameter types in untracked dispatch", () => {
    const source = `
      interface I {
        apply(v: { n: number }): number;
      }
      class Ctx implements I {
        private latest: { n: number } = { n: 0 };
        apply(v: { n: number }): number {
          this.latest = v;
          return this.latest.n;
        }
      }
      class Helper {
        static read(c: I): number {
          return c.apply({ n: 7 });
        }
      }
      class Main {
        private store: Map<string, I> = new Map<string, I>();
        Start(): void {
          this.store.set("k", new Ctx());
          const v = Helper.read(this.store.get("k")!);
          Debug.Log(v);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);

    expect(result.uasm).not.toMatch(/SystemObject\.__apply__/);
    expect(result.uasm).not.toMatch(/I\.__apply__/);
    expect(result.tac).toMatch(/__inst___anon_\d+_\d+_n = 7/);
  });
});

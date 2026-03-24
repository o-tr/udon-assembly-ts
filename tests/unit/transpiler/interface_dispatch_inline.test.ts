/**
 * Tests for interface-typed variable dispatch with all-inline implementors.
 * When all classes implementing an interface are inline (non-UdonBehaviour),
 * property access and method calls through interface-typed variables should
 * be resolved via virtual variables and classId dispatch without EXTERNs.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

/** Extract lines in the _start section (from _start label to its return). */
function getStartSection(tac: string): string {
  const lines = tac.split("\n");
  const startIdx = lines.findIndex((line) => line.includes("_start:"));
  if (startIdx < 0) return "";
  const endIdx = lines.findIndex(
    (line, i) => i > startIdx && line.trim().startsWith("return"),
  );
  return lines
    .slice(startIdx, endIdx !== -1 ? endIdx + 1 : undefined)
    .join("\n");
}

describe("interface dispatch with all-inline implementors", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("dispatches method calls in for-of loop via classId without EXTERN", () => {
    const source = `
      interface IYaku {
        score(): number;
      }
      class Yaku1 implements IYaku {
        private value: number = 10;
        score(): number {
          return this.value;
        }
      }
      class Yaku2 implements IYaku {
        private value: number = 20;
        score(): number {
          return this.value;
        }
      }
      class Main {
        private yakus: IYaku[] = [new Yaku1(), new Yaku2()];
        Start(): void {
          let total: number = 0;
          for (const yaku of this.yakus) {
            total = total + yaku.score();
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Should NOT have EXTERN calls for interface methods
    expect(startSection).not.toContain("EXTERN");

    // Virtual interface variables should be generated
    expect(startSection).toContain("__viface_IYaku");

    // Method body must read from virtual interface-prefixed storage.
    expect(startSection).toMatch(/__viface_IYaku_\d+_value/);
    expect(startSection).toMatch(
      /__viface_IYaku_\d+_value = __inst_Yaku1_\d+_value/,
    );
    expect(startSection).toMatch(
      /__viface_IYaku_\d+_value = __inst_Yaku2_\d+_value/,
    );
    expect(startSection).toMatch(/__inline_ret_\d+ = __viface_IYaku_\d+_value/);
    expect(startSection).toMatch(/__iface_ret_\d+ = __inline_ret_\d+/);
    expect(startSection).toMatch(/t\d+ = total \+ __iface_ret_\d+/);
    expect(startSection).toMatch(
      /__inst_Yaku1_\d+_value = __viface_IYaku_\d+_value/,
    );
    expect(startSection).toMatch(
      /__inst_Yaku2_\d+_value = __viface_IYaku_\d+_value/,
    );
  });

  it("resolves property access in for-of loop via virtual variables without EXTERN", () => {
    const source = `
      interface IItem {
        points: number;
      }
      class ItemA implements IItem {
        points: number = 5;
      }
      class ItemB implements IItem {
        points: number = 10;
      }
      class Main {
        private items: IItem[] = [new ItemA(), new ItemB()];
        Start(): void {
          let total: number = 0;
          for (const item of this.items) {
            total = total + item.points;
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Should NOT have EXTERN calls
    expect(startSection).not.toContain("EXTERN");

    // Virtual interface variables for property access
    expect(startSection).toContain("__viface_IItem");
  });

  it("inlines direct interface-typed variable via tracking propagation", () => {
    const source = `
      interface IGreeter {
        greet(): number;
      }
      class Hello implements IGreeter {
        greet(): number {
          return 1;
        }
      }
      class Main {
        private g: IGreeter = new Hello();
        Start(): void {
          let v: number = this.g.greet();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    // Should inline without EXTERN
    expect(startSection).not.toContain("EXTERN");

    // Inlined constant from greet()
    expect(startSection).toContain("1");
  });

  it("dispatches method with parameters in for-of loop", () => {
    const source = `
      interface ICalc {
        compute(x: number): number;
      }
      class Doubler implements ICalc {
        compute(x: number): number { return x + x; }
      }
      class Tripler implements ICalc {
        compute(x: number): number { return x + x + x; }
      }
      class Main {
        private calcs: ICalc[] = [new Doubler(), new Tripler()];
        Start(): void {
          let total: number = 0;
          for (const c of this.calcs) {
            total = total + c.compute(5);
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    expect(startSection).not.toContain("EXTERN");
    // The argument 5 should appear in the inlined bodies
    expect(startSection).toContain("5");
  });

  it("dispatches void-returning interface method", () => {
    const source = `
      interface IAction {
        execute(): void;
      }
      class ActionA implements IAction {
        private done: boolean = false;
        execute(): void { this.done = true; }
      }
      class ActionB implements IAction {
        private done: boolean = false;
        execute(): void { this.done = true; }
      }
      class Main {
        private actions: IAction[] = [new ActionA(), new ActionB()];
        Start(): void {
          for (const a of this.actions) {
            a.execute();
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    expect(startSection).not.toContain("EXTERN");
    expect(startSection).toContain("__viface_IAction");
    expect(startSection).toMatch(
      /__viface_IAction_\d+_done = __inst_ActionA_\d+_done/,
    );
    expect(startSection).toMatch(
      /__viface_IAction_\d+_done = __inst_ActionB_\d+_done/,
    );
    expect(startSection).toMatch(/__viface_IAction_\d+_done = true/);
    // Write-back should copy virtual field values to concrete instance fields.
    expect(startSection).toMatch(
      /__inst_ActionA_\d+_done = __viface_IAction_\d+_done/,
    );
    expect(startSection).toMatch(
      /__inst_ActionB_\d+_done = __viface_IAction_\d+_done/,
    );
  });

  it("applies write-back even when loop body continues", () => {
    const source = `
      interface IAction {
        execute(): void;
      }
      class ActionA implements IAction {
        private done: boolean = false;
        execute(): void { this.done = true; }
      }
      class Main {
        private actions: IAction[] = [new ActionA()];
        Start(): void {
          for (const a of this.actions) {
            a.execute();
            continue;
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    expect(startSection).toContain("__viface_IAction");
    expect(startSection).toMatch(/__viface_IAction_\d+_done = true/);
    expect(startSection).toMatch(
      /__inst_ActionA_\d+_done = __viface_IAction_\d+_done/,
    );
  });

  it("applies write-back even when loop body breaks", () => {
    const source = `
      interface IAction {
        execute(): void;
      }
      class ActionA implements IAction {
        private done: boolean = false;
        execute(): void { this.done = true; }
      }
      class Main {
        private actions: IAction[] = [new ActionA()];
        Start(): void {
          for (const a of this.actions) {
            a.execute();
            break;
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    expect(startSection).toContain("__viface_IAction");
    expect(startSection).toMatch(/__viface_IAction_\d+_done = true/);
    expect(startSection).toMatch(
      /__inst_ActionA_\d+_done = __viface_IAction_\d+_done/,
    );
  });

  it("applies write-back before early return from loop body", () => {
    const source = `
      interface IAction {
        execute(): void;
      }
      class ActionA implements IAction {
        private done: boolean = false;
        execute(): void { this.done = true; }
      }
      class Main {
        private actions: IAction[] = [new ActionA()];
        Start(): void {
          for (const a of this.actions) {
            a.execute();
            return;
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    const lines = startSection.split("\n");
    const firstReturnLineIndex = lines.findIndex((line) =>
      line.trim().startsWith("return"),
    );
    const writebackLineIndex = lines.findIndex((line) =>
      /__inst_ActionA_\d+_done = __viface_IAction_\d+_done/.test(line),
    );

    const writebackMatch = startSection.match(
      /__inst_ActionA_\d+_done = __viface_IAction_\d+_done/,
    );
    expect(writebackMatch).not.toBeNull();
    expect(firstReturnLineIndex).toBeGreaterThanOrEqual(0);
    expect(writebackLineIndex).toBeGreaterThanOrEqual(0);
    expect(writebackLineIndex).toBeLessThan(firstReturnLineIndex);
  });

  it("applies write-back before uncaught throw exits loop body", () => {
    const source = `
      interface IAction {
        execute(): void;
      }
      class ActionA implements IAction {
        private done: boolean = false;
        execute(): void { this.done = true; }
      }
      class Main {
        private actions: IAction[] = [new ActionA()];
        Start(): void {
          for (const a of this.actions) {
            a.execute();
            throw new Error("x");
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    expect(startSection).toContain("UnityEngineDebug.__LogError");
    const lines = startSection.split("\n");
    const firstReturnLineIndex = lines.findIndex((line) =>
      line.trim().startsWith("return"),
    );
    const writebackLineIndex = lines.findIndex((line) =>
      /__inst_ActionA_\d+_done = __viface_IAction_\d+_done/.test(line),
    );
    const writebackMatch = startSection.match(
      /__inst_ActionA_\d+_done = __viface_IAction_\d+_done/,
    );
    expect(writebackMatch).not.toBeNull();
    expect(firstReturnLineIndex).toBeGreaterThanOrEqual(0);
    expect(writebackLineIndex).toBeGreaterThanOrEqual(0);
    expect(writebackLineIndex).toBeLessThan(firstReturnLineIndex);
  });

  it("restores aliases that temporarily point to virtual interface storage", () => {
    const source = `
      interface IAction {
        execute(): void;
      }
      class ActionA implements IAction {
        private done: boolean = false;
        execute(): void { this.done = true; }
      }
      class Main {
        private actions: IAction[] = [new ActionA()];
        Start(): void {
          let y: IAction = this.actions[0];
          for (const a of this.actions) {
            y = a;
          }
          y.execute();
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);
    const lines = startSection.split("\n");
    const forofEndIndex = lines.findIndex((line) =>
      /^forof_end\d+:$/.test(line.trim()),
    );
    const postLoop =
      forofEndIndex >= 0 ? lines.slice(forofEndIndex + 1) : lines;
    const postLoopText = postLoop.join("\n");

    expect(postLoopText).not.toContain("__viface_IAction");
    expect(postLoopText).not.toContain("__classId");
    expect(postLoopText).toContain("call y.execute()");
  });

  it("handles both property access and method calls on the same interface variable", () => {
    const source = `
      interface IScored {
        base: number;
        bonus(): number;
      }
      class ScoredA implements IScored {
        base: number = 100;
        bonus(): number { return 10; }
      }
      class ScoredB implements IScored {
        base: number = 200;
        bonus(): number { return 20; }
      }
      class Main {
        private items: IScored[] = [new ScoredA(), new ScoredB()];
        Start(): void {
          let total: number = 0;
          for (const s of this.items) {
            total = total + s.base + s.bonus();
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    expect(startSection).not.toContain("EXTERN");
    expect(startSection).toContain("__viface_IScored");
    // Property initial values from both classes
    expect(startSection).toContain("100");
    expect(startSection).toContain("200");
  });

  it("dispatches correctly with three implementing classes", () => {
    const source = `
      interface IShape {
        area(): number;
      }
      class Circle implements IShape {
        private r: number = 3;
        area(): number { return this.r; }
      }
      class Square implements IShape {
        private s: number = 4;
        area(): number { return this.s; }
      }
      class Triangle implements IShape {
        private h: number = 5;
        area(): number { return this.h; }
      }
      class Main {
        private shapes: IShape[] = [new Circle(), new Square(), new Triangle()];
        Start(): void {
          let total: number = 0;
          for (const shape of this.shapes) {
            total = total + shape.area();
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    expect(startSection).not.toContain("EXTERN");
    expect(startSection).toContain("__viface_IShape");
    // Method reads should be virtual-prefixed for private fields.
    expect(startSection).toContain("__viface_IShape_");
    expect(startSection).toMatch(/__viface_IShape_\d+_r/);
    expect(startSection).toMatch(/__viface_IShape_\d+_s/);
    expect(startSection).toMatch(/__viface_IShape_\d+_h/);
    expect(startSection).toMatch(/t\d+ = total \+ __iface_ret_\d+/);
    // Should have three classId dispatch branches
    expect(startSection).toContain("iface_dispatch_next");
  });
});

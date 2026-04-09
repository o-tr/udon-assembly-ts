/**
 * Tests for for-of interface dispatch with 3+ inline implementing classes,
 * parameterized methods, state mutation, and multiple consecutive loops.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
import { getStartSection } from "./test_helpers.js";

describe("interface dispatch: for-of with 3+ classes and state mutation", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("generates viface dispatch for 3 implementing classes with state-mutating method", () => {
    const source = `
      interface IScorer {
        addPoints(n: number): void;
        getPoints(): number;
      }
      class FixedScorer implements IScorer {
        private points: number = 0;
        addPoints(n: number): void { this.points += n; }
        getPoints(): number { return this.points; }
      }
      class DoubleScorer implements IScorer {
        private points: number = 0;
        addPoints(n: number): void { this.points += n * 2; }
        getPoints(): number { return this.points; }
      }
      class BonusScorer implements IScorer {
        private points: number = 0;
        addPoints(n: number): void { this.points += n + 10; }
        getPoints(): number { return this.points; }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private scorers: IScorer[] = [new FixedScorer(), new DoubleScorer(), new BonusScorer()];
        Start(): void {
          for (const s of this.scorers) {
            s.addPoints(5);
          }
          let total: number = 0;
          for (const s of this.scorers) {
            total += s.getPoints();
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    expect(startSection).not.toContain("EXTERN");
    expect(startSection).toContain("__viface_IScorer");

    // copy-in: concrete → viface for all 3 classes
    expect(startSection).toMatch(
      /__viface_IScorer_\d+_points = __inst_FixedScorer_\d+_points/,
    );
    expect(startSection).toMatch(
      /__viface_IScorer_\d+_points = __inst_DoubleScorer_\d+_points/,
    );
    expect(startSection).toMatch(
      /__viface_IScorer_\d+_points = __inst_BonusScorer_\d+_points/,
    );

    // write-back: viface → concrete for all 3 classes
    expect(startSection).toMatch(
      /__inst_FixedScorer_\d+_points = __viface_IScorer_\d+_points/,
    );
    expect(startSection).toMatch(
      /__inst_DoubleScorer_\d+_points = __viface_IScorer_\d+_points/,
    );
    expect(startSection).toMatch(
      /__inst_BonusScorer_\d+_points = __viface_IScorer_\d+_points/,
    );
  });

  it("passes method parameters through viface dispatch without EXTERN", () => {
    const source = `
      interface IAccum {
        add(x: number, y: number): number;
      }
      class AccumA implements IAccum {
        add(x: number, y: number): number { return x + y; }
      }
      class AccumB implements IAccum {
        add(x: number, y: number): number { return x * y; }
      }
      class AccumC implements IAccum {
        add(x: number, y: number): number { return x - y; }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private items: IAccum[] = [new AccumA(), new AccumB(), new AccumC()];
        Start(): void {
          for (const item of this.items) {
            Debug.Log(item.add(10, 3));
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    expect(startSection).not.toContain("EXTERN");
    expect(startSection).toContain("__viface_IAccum");

    // arguments appear as parameter bindings in each inlined dispatch body
    expect(startSection).toContain("x = 10");
    expect(startSection).toContain("y = 3");

    // 3 classId dispatch branches
    const dispatchNextCount = (startSection.match(/iface_dispatch_next/g) || [])
      .length;
    expect(dispatchNextCount).toBeGreaterThanOrEqual(3);
  });

  it("generates independent viface blocks for multiple for-of loops over the same array", () => {
    const source = `
      interface IItem {
        value: number;
      }
      class ItemA implements IItem { value: number = 1; }
      class ItemB implements IItem { value: number = 2; }
      class ItemC implements IItem { value: number = 3; }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private items: IItem[] = [new ItemA(), new ItemB(), new ItemC()];
        Start(): void {
          for (const item of this.items) {
            Debug.Log(item.value);
          }
          for (const item of this.items) {
            Debug.Log(item.value);
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    expect(startSection).not.toContain("EXTERN");

    // Two loops produce two independent viface blocks (_0 and _1)
    expect(startSection).toMatch(/__viface_IItem_0/);
    expect(startSection).toMatch(/__viface_IItem_1/);
  });

  it("write-back preserves state across consecutive mutation loops with 3 classes", () => {
    const source = `
      interface ICounter {
        inc(): void;
        get(): number;
      }
      class CounterA implements ICounter {
        private n: number = 0;
        inc(): void { this.n++; }
        get(): number { return this.n; }
      }
      class CounterB implements ICounter {
        private n: number = 0;
        inc(): void { this.n += 2; }
        get(): number { return this.n; }
      }
      class CounterC implements ICounter {
        private n: number = 0;
        inc(): void { this.n += 3; }
        get(): number { return this.n; }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private counters: ICounter[] = [new CounterA(), new CounterB(), new CounterC()];
        Start(): void {
          for (const c of this.counters) {
            c.inc();
          }
          for (const c of this.counters) {
            Debug.Log(c.get());
          }
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const startSection = getStartSection(result.tac);

    expect(startSection).not.toContain("EXTERN");
    expect(startSection).toContain("__viface_ICounter");

    // write-back from the first (mutation) loop
    expect(startSection).toMatch(
      /__inst_CounterA_\d+_n = __viface_ICounter_\d+_n/,
    );
    expect(startSection).toMatch(
      /__inst_CounterB_\d+_n = __viface_ICounter_\d+_n/,
    );
    expect(startSection).toMatch(
      /__inst_CounterC_\d+_n = __viface_ICounter_\d+_n/,
    );

    // copy-in for the second (read) loop reads the written-back state
    expect(startSection).toMatch(
      /__viface_ICounter_\d+_n = __inst_CounterA_\d+_n/,
    );
    expect(startSection).toMatch(
      /__viface_ICounter_\d+_n = __inst_CounterB_\d+_n/,
    );
    expect(startSection).toMatch(
      /__viface_ICounter_\d+_n = __inst_CounterC_\d+_n/,
    );
  });
});

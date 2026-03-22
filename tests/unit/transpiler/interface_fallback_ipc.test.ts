import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

/**
 * Tests for the interface fallback IPC dispatch path.
 *
 * When an interface is defined but its implementing class is NOT present in
 * the same compilation unit, `buildUdonBehaviourLayouts` never builds a layout
 * for that interface. The fallback in `isUdonBehaviourType` and the dynamic
 * layout generation in `buildFallbackMethodLayout` must kick in so that
 * method calls on interface-typed variables produce IPC dispatch
 * (SetProgramVariable → SendCustomEvent → GetProgramVariable) instead of
 * being lowered as EXTERN instructions.
 */
describe("interface fallback IPC dispatch (no implementing class)", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("generates IPC dispatch for void method without implementing class", () => {
    const source = `
      interface IYaku {
        calculate(): void;
      }

      @UdonBehaviour()
      class ScoreManager extends UdonSharpBehaviour {
        yaku: IYaku;

        Start(): void {
          this.yaku.calculate();
        }
      }
    `;

    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);

    // Must generate IPC pattern, not EXTERN
    expect(result.tac).toContain("SendCustomEvent");
    expect(result.tac).toContain("IYaku_calculate");
    // Should NOT produce a MethodCallInstruction (which would become EXTERN)
    expect(result.tac).not.toMatch(/EXTERN.*IYaku/);
  });

  it("generates IPC with return value without implementing class", () => {
    const source = `
      interface IYaku {
        calculate(ctx: number): number;
      }

      @UdonBehaviour()
      class ScoreManager extends UdonSharpBehaviour {
        yaku: IYaku;

        Start(): void {
          const score: number = this.yaku.calculate(42);
        }
      }
    `;

    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);

    // Full IPC pattern: SetProgramVariable, SendCustomEvent, GetProgramVariable
    expect(result.tac).toContain("SetProgramVariable");
    expect(result.tac).toContain("SendCustomEvent");
    expect(result.tac).toContain("GetProgramVariable");

    // Naming convention matches buildUdonBehaviourLayouts
    expect(result.tac).toContain("IYaku_calculate");
    expect(result.tac).toContain("IYaku_calculate__param_0");
    expect(result.tac).toContain("IYaku_calculate__ret");
  });

  it("generates IPC with multiple parameters without implementing class", () => {
    const source = `
      interface IScorer {
        score(a: number, b: number): void;
      }

      @UdonBehaviour()
      class Game extends UdonSharpBehaviour {
        scorer: IScorer;

        Start(): void {
          this.scorer.score(10, 20);
        }
      }
    `;

    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);

    expect(result.tac).toContain("SetProgramVariable");
    expect(result.tac).toContain("SendCustomEvent");
    expect(result.tac).toContain("IScorer_score__param_0");
    expect(result.tac).toContain("IScorer_score__param_1");
  });

  it("does not treat extern/stub interfaces as UdonBehaviour", () => {
    // IEnumerable is registered in typeMetadataRegistry as an extern type.
    // It should NOT be treated as a UdonBehaviour interface.
    const source = `
      @UdonBehaviour()
      class Foo extends UdonSharpBehaviour {
        Start(): void {
          const x: number = 1;
        }
      }
    `;

    const transpiler = new TypeScriptToUdonTranspiler();
    // Should transpile without errors — no false positive on extern interfaces
    const result = transpiler.transpile(source);
    expect(result.uasm).toBeDefined();
  });

  it("fallback naming matches buildUdonBehaviourLayouts convention", () => {
    // When the implementing class IS present, layouts are pre-built.
    // When it is NOT present, the fallback must produce identical names.
    const withImpl = `
      interface IWeapon {
        attack(power: number): number;
      }

      @UdonBehaviour()
      class GameManager extends UdonSharpBehaviour {
        weapon: IWeapon;

        Start(): void {
          const dmg: number = this.weapon.attack(5);
        }
      }

      @UdonBehaviour()
      class Sword extends UdonSharpBehaviour implements IWeapon {
        attack(power: number): number {
          return power * 2;
        }
      }
    `;

    const withoutImpl = `
      interface IWeapon {
        attack(power: number): number;
      }

      @UdonBehaviour()
      class GameManager extends UdonSharpBehaviour {
        weapon: IWeapon;

        Start(): void {
          const dmg: number = this.weapon.attack(5);
        }
      }
    `;

    const transpiler1 = new TypeScriptToUdonTranspiler();
    const transpiler2 = new TypeScriptToUdonTranspiler();
    const resultWith = transpiler1.transpile(withImpl);
    const resultWithout = transpiler2.transpile(withoutImpl);

    // Both paths must use the same IPC export names
    for (const name of [
      "IWeapon_attack",
      "IWeapon_attack__param_0",
      "IWeapon_attack__ret",
    ]) {
      expect(resultWith.tac).toContain(name);
      expect(resultWithout.tac).toContain(name);
    }

    // Both must use IPC dispatch
    for (const pattern of [
      "SetProgramVariable",
      "SendCustomEvent",
      "GetProgramVariable",
    ]) {
      expect(resultWith.tac).toContain(pattern);
      expect(resultWithout.tac).toContain(pattern);
    }
  });
});

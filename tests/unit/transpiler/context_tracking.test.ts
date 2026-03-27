import { describe, it, expect } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("CheckWinContext tracking", () => {
  it("should inline type alias fields through multiple nested calls", () => {
    const source = `
      import { UdonBehaviour } from "./src/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "./src/stubs/UdonSharpBehaviour";
      import { Debug } from "./src/stubs/UnityTypes";

      type Context = {
        isRiichi: boolean;
        isTsumo: boolean;
      };

      class Inner {
        static build(ctx: Context): boolean {
          return ctx.isRiichi;
        }
      }

      class Outer {
        static process(ctx: Context): boolean {
          return Inner.build(ctx);
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const ctx: Context = { isRiichi: true, isTsumo: false };
          const r = Outer.process(ctx);
          Debug.Log(r);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    expect(result.uasm).not.toMatch(/Context\.__get_/);
  });

  it("should inline type alias fields through 3 levels of nesting", () => {
    const source = `
      import { UdonBehaviour } from "./src/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "./src/stubs/UdonSharpBehaviour";
      import { Debug } from "./src/stubs/UnityTypes";

      type Context = {
        isRiichi: boolean;
      };

      class A {
        static check(ctx: Context): boolean {
          return ctx.isRiichi;
        }
      }

      class B {
        static process(ctx: Context): boolean {
          return A.check(ctx);
        }
      }

      class C {
        static run(ctx: Context): boolean {
          return B.process(ctx);
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const ctx: Context = { isRiichi: true };
          const r = C.run(ctx);
          Debug.Log(r);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    expect(result.uasm).not.toMatch(/Context\.__get_/);
  });

  it("should inline CheckWinContext fields through buildYakuCheckContext pattern", () => {
    // Mirrors the HandAnalyzer.buildYakuCheckContext pattern:
    // CheckWinContext → YakuCheckContext with nested checks
    const source = `
      import { UdonBehaviour } from "./src/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "./src/stubs/UdonSharpBehaviour";
      import { Debug } from "./src/stubs/UnityTypes";

      type CheckCtx = {
        isRiichi: boolean;
        isTsumo: boolean;
      };

      type YakuCtx = {
        isRiichi: boolean;
        isTsumo: boolean;
      };

      class Inner {
        static check(ctx: YakuCtx): boolean {
          return ctx.isRiichi && ctx.isTsumo;
        }
      }

      class Builder {
        static buildYakuCtx(ctx: CheckCtx): YakuCtx {
          return {
            isRiichi: ctx.isRiichi,
            isTsumo: ctx.isTsumo,
          };
        }
      }

      class Analyzer {
        static checkWin(ctx: CheckCtx): boolean {
          const yakuCtx = Builder.buildYakuCtx(ctx);
          return Inner.check(yakuCtx);
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const ctx: CheckCtx = { isRiichi: true, isTsumo: false };
          const r = Analyzer.checkWin(ctx);
          Debug.Log(r);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    expect(result.uasm).not.toMatch(/CheckCtx\.__get_/);
    expect(result.uasm).not.toMatch(/YakuCtx\.__get_/);
  });

  it("should inline type alias context through instance method chain", () => {
    // Mirrors: HandAnalyzer (instance) calling multiple private methods that pass context
    const source = `
      import { UdonBehaviour } from "./src/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "./src/stubs/UdonSharpBehaviour";
      import { Debug } from "./src/stubs/UnityTypes";

      type Ctx = {
        isRiichi: boolean;
        isTsumo: boolean;
      };

      type YakuCtx = {
        isRiichi: boolean;
        isTsumo: boolean;
      };

      class Analyzer {
        private buildCtx(ctx: Ctx): YakuCtx {
          return {
            isRiichi: ctx.isRiichi,
            isTsumo: ctx.isTsumo,
          };
        }

        checkWin(ctx: Ctx): boolean {
          const yakuCtx = this.buildCtx(ctx);
          return yakuCtx.isRiichi;
        }
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const analyzer = new Analyzer();
          const ctx: Ctx = { isRiichi: true, isTsumo: false };
          const r = analyzer.checkWin(ctx);
          Debug.Log(r);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    expect(result.uasm).not.toMatch(/Ctx\.__get_/);
    expect(result.uasm).not.toMatch(/YakuCtx\.__get_/);
  });
});

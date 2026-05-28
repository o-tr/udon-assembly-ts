import { describe, expect, it } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("setImmediate inline callback lowering", () => {
  it("inlines simple setImmediate(callback) without throwing and emits TAC/uasm", () => {
    const src = `
    class Foo {
      start() {
        setImmediate(() => this.startLater());
      }
      startLater() {
        const x = 1 + 2;
        console.log(x);
      }
    }
    `;

    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(src, { optimize: false });

    // Should produce TAC and UASM output strings
    expect(result).toBeDefined();
    expect(typeof result.tac).toBe("string");
    expect(typeof result.uasm).toBe("string");

    // Ensure the call was scheduled via SendCustomEventDelayedFrames
    expect(result.tac).toContain("SendCustomEventDelayedFrames");
    expect(result.uasm.length).toBeGreaterThan(0);
  });

  it("unwraps block-bodied callback expression statements", () => {
    const src = `
    class Foo {
      start() {
        setImmediate(() => {
          this.startLater();
        });
      }
      startLater() {
        console.log(1);
      }
    }
    `;

    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(src, { optimize: false });

    expect(result.tac).toContain("SendCustomEventDelayedFrames");
    expect(result.tac).toContain("startLater");
  });
});

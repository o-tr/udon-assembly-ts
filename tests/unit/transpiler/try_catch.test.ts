import { describe, expect, it } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

const transpileTac = (source: string): string =>
  new TypeScriptToUdonTranspiler().transpile(source, { silent: true }).tac;

describe("try/catch expansion", () => {
  it("inserts error flag and catch labels", () => {
    const source = `
      class Demo {
        Start(): void {
          try {
            this.SendCustomEvent("Ok");
          } catch (e) {
            this.SendCustomEvent("Fail");
          }
        }
      }
    `;
    const tacText = transpileTac(source);

    expect(tacText).toContain("__error_flag_");
    expect(tacText).toContain("catch_");
  });

  it("handles throw by jumping to catch", () => {
    const source = `
      class Demo {
        Start(): void {
          try {
            throw 1;
          } catch (e) {
            this.SendCustomEvent("Thrown");
          }
        }
      }
    `;
    const tacText = transpileTac(source);

    expect(tacText).toContain("goto catch_");
  });

  it("runs finally before a break without heavy error-flag lowering", () => {
    const source = `
      class Demo {
        Start(): void {
          while (true) {
            try {
              break;
            } finally {
              this.SendCustomEvent("Done");
            }
          }
        }
      }
    `;
    const tacText = transpileTac(source);
    const doneIndex = tacText.indexOf(
      'SendCustomEvent__SystemString__SystemVoid(this, "Done")',
    );
    const finallyJumpIndex = tacText.indexOf("finally_jump_while_end");
    const gotoIndex = tacText.lastIndexOf("goto while_end");

    expect(tacText).not.toContain("__error_flag_");
    expect(tacText).toContain("finally_jump_while_end");
    expect(tacText).toContain(
      'SendCustomEvent__SystemString__SystemVoid(this, "Done")',
    );
    expect(tacText).toContain("goto while_end");
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(finallyJumpIndex).toBeGreaterThanOrEqual(0);
    expect(gotoIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeLessThan(gotoIndex);
    expect(finallyJumpIndex).toBeLessThan(gotoIndex);
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("compound assignment and update operators", () => {
  let transpiler: TypeScriptToUdonTranspiler;

  beforeAll(() => {
    transpiler = new TypeScriptToUdonTranspiler();
  });

  it("emits TAC for compound assignment +=", () => {
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void { let x: number = 0; x += 5; Debug.Log(x); }
      }`;
    const result = transpiler.transpile(source);
    expect(result.tac).toContain("x + 5");
    expect(result.tac).toContain("x = t");
  });

  it("emits TAC for compound assignment -=, *=, /=, %=", () => {
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void {
          let a: number = 10;
          a -= 3; a *= 2; a /= 7; a %= 3;
          Debug.Log(a);
        }
      }`;
    const result = transpiler.transpile(source);
    expect(result.tac).toContain("a - 3");
    expect(result.tac).toContain("a * 2");
    expect(result.tac).toContain("a / 7");
    expect(result.tac).toContain("a % 3");
  });

  it("emits TAC for postfix increment ++", () => {
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void { let x: number = 5; x++; Debug.Log(x); }
      }`;
    const result = transpiler.transpile(source);
    expect(result.tac).toContain("x + 1");
    expect(result.tac).toContain("x = t");
  });

  it("emits TAC for postfix decrement --", () => {
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void { let x: number = 5; x--; Debug.Log(x); }
      }`;
    const result = transpiler.transpile(source);
    expect(result.tac).toContain("x - 1");
  });

  it("uses matching type for ++ delta on Single variable", () => {
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void { let x: number = 5; x++; Debug.Log(x); }
      }`;
    const result = transpiler.transpile(source);
    // The ++ operation on Single should use Single addition, not Int32
    expect(result.uasm).toContain("op_Addition__SystemSingle_SystemSingle");
    expect(result.uasm).not.toContain(
      "op_Addition__SystemInt32_SystemInt32__SystemInt32",
    );
  });
});

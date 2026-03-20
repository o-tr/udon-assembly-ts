import { beforeAll, describe, expect, it } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("Convert method overload resolution", () => {
  let transpiler: TypeScriptToUdonTranspiler;

  beforeAll(() => {
    transpiler = new TypeScriptToUdonTranspiler();
  });

  it("resolves Convert.ToInt32(UdonFloat) to SystemSingle overload", () => {
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Convert } from "@ootr/udon-assembly-ts/stubs/SystemTypes";
      import type { UdonFloat, UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void {
          const a: UdonFloat = 3.7 as UdonFloat;
          const b: UdonInt = Convert.ToInt32(a);
          Debug.Log(b);
        }
      }`;
    const result = transpiler.transpile(source);
    expect(result.uasm).toContain(
      "SystemConvert.__ToInt32__SystemSingle__SystemInt32",
    );
    expect(result.uasm).not.toContain(
      "SystemConvert.__ToInt32__SystemByte__SystemInt32",
    );
  });

  it("resolves Convert.ToInt32(UdonInt) to SystemInt32 overload", () => {
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Convert } from "@ootr/udon-assembly-ts/stubs/SystemTypes";
      import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void {
          const a: UdonInt = 42 as UdonInt;
          const b: UdonInt = Convert.ToInt32(a);
          Debug.Log(b);
        }
      }`;
    const result = transpiler.transpile(source);
    expect(result.uasm).toContain(
      "SystemConvert.__ToInt32__SystemInt32__SystemInt32",
    );
  });

  it("resolves Convert.ToSingle(UdonInt) to SystemInt32 overload", () => {
    const source = `
      import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
      import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
      import { Convert } from "@ootr/udon-assembly-ts/stubs/SystemTypes";
      import type { UdonFloat, UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
      import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void {
          const a: UdonInt = 42 as UdonInt;
          const b: UdonFloat = Convert.ToSingle(a);
          Debug.Log(b);
        }
      }`;
    const result = transpiler.transpile(source);
    expect(result.uasm).toContain(
      "SystemConvert.__ToSingle__SystemInt32__SystemSingle",
    );
  });
});

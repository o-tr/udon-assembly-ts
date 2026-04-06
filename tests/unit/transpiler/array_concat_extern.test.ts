import { describe, expect, it } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("array concat extern signatures", () => {
  it("emits required signatures and avoids deprecated ones", () => {
    const source = `
      class Demo {
        Start(): void {
          const left: Box[] = [new Box(10), new Box(20)];
          const right: Box[] = [new Box(30)];
          left.concat(right);
          left.concat(new Box(40));
        }
      }
      class Box {
        v: number = 0;
        constructor(v: number) { this.v = v; }
      }
    `;

    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);
    expect(result).toBeTruthy();
    expect(result.uasm).toBeTruthy();
    const uasm = result.uasm;

    const required = [
      "VRCSDK3DataDataList.__ctor____VRCSDK3DataDataList",
      "VRCSDK3DataDataList.__Add__VRCSDK3DataDataToken__SystemVoid",
      "VRCSDK3DataDataList.__get_Item__SystemInt32__VRCSDK3DataDataToken",
      "VRCSDK3DataDataList.__get_Count__SystemInt32",
      "VRCSDK3DataDataToken.__ctor__",
    ];
    for (const sig of required) {
      expect(uasm).toContain(sig);
    }

    const disallowed = [
      "SystemArray.__get_Length__SystemInt32",
      "SystemObjectArray.__get_length__SystemInt32",
      "SystemObjectArray.__Get__",
      "SystemObjectArray.__Set__",
      "SystemObjectArray.__ctor__",
      "SystemArray.__Copy__",
      "ObjectArray.__ctor__SystemInt32__ObjectArray",
    ];
    for (const sig of disallowed) {
      expect(uasm).not.toContain(sig);
    }
  });
});

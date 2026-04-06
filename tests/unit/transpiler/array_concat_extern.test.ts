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
      "SystemObjectArray.__Set__SystemInt32_SystemObject__SystemVoid",
      "SystemObjectArray.__ctor__SystemInt32__SystemObjectArray",
      "SystemArray.__Copy__SystemArray_SystemInt64_SystemArray_SystemInt64_SystemInt64__SystemVoid",
      "VRCSDK3DataDataList.__get_Item__SystemInt32__VRCSDK3DataDataToken",
    ];
    for (const sig of required) {
      expect(uasm).toContain(sig);
    }

    const disallowed = [
      "SystemArray.__get_Length__SystemInt32",
      "SystemObjectArray.__get_length__SystemInt32",
      "ObjectArray.__ctor__SystemInt32__ObjectArray",
      "SystemObjectArray.__Copy__SystemObjectArray_SystemInt32_SystemObjectArray_SystemInt32_SystemInt32__SystemVoid",
      "SystemArray.__Copy__SystemObject_SystemInt32_SystemObject_SystemInt32_SystemInt32__SystemVoid",
    ];
    for (const sig of disallowed) {
      expect(uasm).not.toContain(sig);
    }
  });
});

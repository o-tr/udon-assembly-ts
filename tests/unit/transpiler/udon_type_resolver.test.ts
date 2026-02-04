import { describe, expect, it } from "vitest";
import { EXTERN_METHODS } from "../../../src/transpiler/codegen/extern_signatures";
import {
  generateExternSignature,
  toUdonTypeName,
  toUdonTypeNameWithArray,
} from "../../../src/transpiler/codegen/udon_type_resolver";

describe("udon type resolver", () => {
  it("converts C# type names to Udon names", () => {
    expect(toUdonTypeName("System.Int32")).toBe("SystemInt32");
    expect(toUdonTypeName("VRC.SDKBase.VRCPlayerApi")).toBe(
      "VRCSDKBaseVRCPlayerApi",
    );
  });

  it("handles arrays in Udon type names", () => {
    expect(toUdonTypeNameWithArray("System.Int32[]")).toBe("SystemInt32Array");
  });

  it("generates extern signatures", () => {
    const sig = generateExternSignature(
      "UnityEngine.Debug",
      "Log",
      ["System.Object"],
      "System.Void",
    );
    expect(sig).toBe("UnityEngineDebug.__Log__SystemObject__SystemVoid");
  });

  it("matches existing static externs", () => {
    const sig = generateExternSignature(
      "UnityEngine.Debug",
      "Log",
      ["System.Object"],
      "System.Void",
    );
    expect(EXTERN_METHODS.get("Debug.Log")).toBe(sig);
  });
});

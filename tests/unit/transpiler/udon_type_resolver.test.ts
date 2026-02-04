import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { resolveExternSignature } from "../../../src/transpiler/codegen/extern_signatures";
import {
  generateExternSignature,
  toUdonTypeName,
  toUdonTypeNameWithArray,
} from "../../../src/transpiler/codegen/udon_type_resolver";

describe("udon type resolver", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("initializes extern registry from stubs", () => {
    expect(resolveExternSignature("Debug", "Log", "method")).toBe(
      "UnityEngineDebug.__Log__SystemObject__SystemVoid",
    );
  });

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
});

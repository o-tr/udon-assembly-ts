import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { resolveExternSignature } from "../../../src/transpiler/codegen/extern_signatures";

describe("type metadata registry", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("resolves Material.SetColor extern", () => {
    const sig = resolveExternSignature(
      "Material",
      "SetColor",
      "method",
      ["string", "Color"],
      "void",
    );
    expect(sig).toBe(
      "UnityEngineMaterial.__SetColor__SystemString_UnityEngineColor__SystemVoid",
    );
  });

  it("resolves Rigidbody.AddForce extern", () => {
    const sig = resolveExternSignature(
      "Rigidbody",
      "AddForce",
      "method",
      ["Vector3"],
      "void",
    );
    expect(sig).toBe(
      "UnityEngineRigidbody.__AddForce__UnityEngineVector3__SystemVoid",
    );
  });

  it("resolves VRCPlayerApi.TeleportTo extern", () => {
    const sig = resolveExternSignature(
      "VRCPlayerApi",
      "TeleportTo",
      "method",
      ["Vector3", "Quaternion"],
      "void",
    );
    expect(sig).toBe(
      "VRCSDKBaseVRCPlayerApi.__TeleportTo__UnityEngineVector3_UnityEngineQuaternion__SystemVoid",
    );
  });

  it("resolves VRCPlayerApi.GetPlayerCount extern", () => {
    const sig = resolveExternSignature(
      "VRCPlayerApi",
      "GetPlayerCount",
      "method",
    );
    expect(sig).toBe("VRCSDKBaseVRCPlayerApi.__GetPlayerCount____SystemInt32");
  });

  it("resolves VRCPlayerApi.GetPlayers extern", () => {
    const sig = resolveExternSignature("VRCPlayerApi", "GetPlayers", "method");
    expect(sig).toBe(
      "VRCSDKBaseVRCPlayerApi.__GetPlayers__VRCSDKBaseVRCPlayerApiArray__SystemInt32",
    );
  });
});

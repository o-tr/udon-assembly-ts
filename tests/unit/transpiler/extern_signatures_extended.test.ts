/**
 * Extern signature expansion tests
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { resolveExternSignature } from "../../../src/transpiler/codegen/extern_signatures";

describe("extern signatures expansion", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("should include Mathf and String externs", () => {
    expect(resolveExternSignature("Mathf", "Abs", "method")).toBe(
      "UnityEngineMathf.__Abs__SystemSingle__SystemSingle",
    );
    expect(resolveExternSignature("Mathf", "Clamp", "method")).toBe(
      "UnityEngineMathf.__Clamp__SystemSingle_SystemSingle_SystemSingle__SystemSingle",
    );
    expect(resolveExternSignature("String", "Contains", "method")).toBe(
      "SystemString.__Contains__SystemString__SystemBoolean",
    );
    expect(
      resolveExternSignature(
        "String",
        "Substring",
        "method",
        ["int"],
        "string",
      ),
    ).toBe("SystemString.__Substring__SystemInt32__SystemString");
    expect(
      resolveExternSignature(
        "String",
        "Substring",
        "method",
        ["int", "int"],
        "string",
      ),
    ).toBe("SystemString.__Substring__SystemInt32_SystemInt32__SystemString");
  });

  it("should include Transform and GameObject properties", () => {
    expect(resolveExternSignature("Transform", "localPosition", "getter")).toBe(
      "UnityEngineTransform.__get_localPosition____UnityEngineVector3",
    );
    expect(resolveExternSignature("Transform", "localRotation", "getter")).toBe(
      "UnityEngineTransform.__get_localRotation____UnityEngineQuaternion",
    );
    expect(resolveExternSignature("GameObject", "activeSelf", "getter")).toBe(
      "UnityEngineGameObject.__get_activeSelf____SystemBoolean",
    );
    expect(resolveExternSignature("GameObject", "transform", "getter")).toBe(
      "UnityEngineGameObject.__get_transform____UnityEngineTransform",
    );
  });
});

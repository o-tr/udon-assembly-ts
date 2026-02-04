import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { resolveExternSignature } from "../../../src/transpiler/codegen/extern_signatures";

describe("extern registry decorators", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("uses @UdonExtern signature override on UdonBehaviour", () => {
    const sig = resolveExternSignature(
      "UdonBehaviour",
      "SendCustomNetworkEvent",
      "method",
      ["NetworkEventTarget", "string"],
      "void",
    );
    expect(sig).toBe(
      "VRCUdonCommonInterfacesIUdonEventReceiver.__SendCustomNetworkEvent__VRCUdonCommonEnumsNetworkEventTarget_SystemString__SystemVoid",
    );
  });

  it("selects DataToken constructor overload by parameter type", () => {
    const sig = resolveExternSignature(
      "DataToken",
      "ctor",
      "method",
      ["string"],
      "DataToken",
    );
    expect(sig).toBe(
      "VRCSDK3DataDataToken.__ctor__SystemString__VRCSDK3DataDataToken",
    );
  });
});

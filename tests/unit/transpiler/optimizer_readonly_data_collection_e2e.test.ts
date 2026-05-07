import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

beforeAll(() => {
  buildExternRegistryFromFiles([]);
});

describe("e2e: readonlyDataCollectionFolding fires on real transpiler output", () => {
  it("folds get_Item away in optimized TAC for DataList initialized via push", () => {
    const source = `
@UdonBehaviour()
class DataListFoldTest extends UdonSharpBehaviour {
  Start(): void {
    const items: string[] = [];
    items.push("hello");
    items.push("world");
    const x = items[0];
    this.logVal(x);
  }
  logVal(s: string): void {}
}
`;

    const resultRaw = new TypeScriptToUdonTranspiler().transpile(source, {
      optimize: false,
    });
    const resultOpt = new TypeScriptToUdonTranspiler().transpile(source, {
      optimize: true,
    });

    // Unoptimized TAC must have get_Item (proving the pattern exists)
    expect(resultRaw.tac).toContain("get_Item");

    // Optimized TAC must NOT have get_Item (proving the fold fired)
    expect(resultOpt.tac).not.toContain("get_Item");
  });
});

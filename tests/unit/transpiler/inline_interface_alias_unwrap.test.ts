import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("inline interface alias unwrap", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("unwraps Map<string, IAlias> value into %SystemInt32, not %SystemObject", () => {
    const source = `
      type IAlias = { val: number };

      class ImplA implements IAlias {
        val: number = 42;
      }

      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        registry: Map<string, IAlias> = new Map();

        @EntryPoint()
        _start(): void {
          this.registry.set("a", new ImplA());
          const got = this.registry.get("a");
          if (got !== null) {
            Debug.Log(got.val.toString());
          }
        }
      }
    `;

    const { uasm } = new TypeScriptToUdonTranspiler().transpile(source);

    // Read path: the temp holding the unwrapped handle must be %SystemInt32,
    // not %SystemObject. Externs are declared as `__extern_N: %SystemString,
    // "DataToken.__get_Int__SystemInt32"` and called as `EXTERN, __extern_N`.
    // Find the extern alias, then find the PUSH (output slot) before it.
    const lines = uasm.split("\n");

    // 1. Find the extern alias for DataToken.__get_Int__
    const externDeclLine = lines.find((l) =>
      l.includes("DataToken.__get_Int__SystemInt32"),
    );
    expect(externDeclLine).toBeDefined();
    if (!externDeclLine) return;
    const externAlias = externDeclLine.trim().split(":")[0].trim();

    // 2. Find the EXTERN opcode that uses this alias
    const externCallIdx = lines.findIndex(
      (l) => l.includes("EXTERN,") && l.trim().split(/,\s*/)[1] === externAlias,
    );
    expect(externCallIdx).toBeGreaterThan(-1);

    // 3. The PUSH immediately before EXTERN is the output slot
    const pushLine = lines[externCallIdx - 1];
    expect(pushLine).toMatch(/PUSH,\s+\S+/);
    const outputVar = pushLine.replace(/.*PUSH,\s+/, "").trim();

    // 4. The output slot variable must be declared as %SystemInt32
    const declLine = lines.find(
      (l) => l.includes(`${outputVar}:`) && l.includes("%System"),
    );
    expect(declLine).toBeDefined();
    expect(declLine).toContain("%SystemInt32");
    expect(declLine).not.toContain("%SystemObject");
  });
});

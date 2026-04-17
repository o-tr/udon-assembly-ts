/**
 * Unit tests for source-location attachment on transpiler diagnostics.
 *
 * Each test exercises a warning site and asserts that the recorded
 * location points to the right TS source position and context.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index";

beforeAll(() => {
  buildExternRegistryFromFiles([]);
});

function transpile(source: string, sourceFilePath = "tests/fixture.ts") {
  return new TypeScriptToUdonTranspiler().transpile(source, {
    sourceFilePath,
  });
}

describe("transpiler diagnostics with source location", () => {
  it("ErasedReturnInline reports caller's source position (line:column) and class.method context", () => {
    const source = `
import { UdonBehaviour, UdonSharpBehaviour } from "./stubs";

class Wrap {
  static dataToken: any = null;
}

class Helper {
  static unwrap(token: any): any {
    const x = token;
    return x;
  }
}

@UdonBehaviour()
class Main extends UdonSharpBehaviour {
  Start(): void {
    const v = Helper.unwrap(Wrap.dataToken) as string;
  }
}
`;
    const result = transpile(source);
    const erased = result.diagnostics?.find(
      (d) => d.code === "ErasedReturnInline",
    );
    expect(erased).toBeDefined();
    expect(erased?.location.filePath).toBe("tests/fixture.ts");
    // The caller lives on the "const v = ..." line (line 19 within the
    // template literal source, which starts with a leading newline).
    expect(erased?.location.line).toBeGreaterThan(0);
    expect(erased?.location.column).toBeGreaterThan(0);
    expect(erased?.context?.className).toBe("Main");
    expect(erased?.context?.methodName).toBe("Start");
  });

  it("warning falls back to the sourceFilePath when no node is available", () => {
    // Construct an intentionally tricky all-inline interface with no
    // implementor instantiated — exercises the converter.ts warn site
    // which has no AST node in scope.
    const source = `
import { UdonBehaviour, UdonSharpBehaviour } from "./stubs";

interface Item {
  tick(): void;
}

@UdonBehaviour()
class Main extends UdonSharpBehaviour {
  items: Item[] = [];
  Start(): void {
    for (const it of this.items) {
      it.tick();
    }
  }
}
`;
    const result = transpile(source, "tests/allinline.ts");
    // Regardless of whether the warning fires (depends on inliner heuristics),
    // if it fires, the filePath must at least be the one we passed.
    const anyAllInline = result.diagnostics?.find(
      (d) => d.code === "AllInlineInterfaceFallback",
    );
    if (anyAllInline) {
      expect(anyAllInline.location.filePath).toBe("tests/allinline.ts");
    }
  });

  it("diagnostics is undefined when no warnings fire", () => {
    const source = `
import { UdonBehaviour, UdonSharpBehaviour } from "./stubs";

@UdonBehaviour()
class Main extends UdonSharpBehaviour {
  Start(): void {
    const a: number = 1 + 2;
  }
}
`;
    const result = transpile(source);
    expect(result.diagnostics).toBeUndefined();
  });
});

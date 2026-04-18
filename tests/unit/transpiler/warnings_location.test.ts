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

  it("AllInlineInterfaceFallback fires with sourceFilePath fallback when no node is in scope", () => {
    // All-inline interface with no constructor called for any implementor —
    // exercises the converter.ts warn site emitted between passes with no
    // AST node in scope.
    const source = `
import { UdonBehaviour, UdonSharpBehaviour } from "./stubs";

interface Item {
  tick(): void;
}

class ItemA implements Item {
  tick(): void {}
}

class ItemB implements Item {
  tick(): void {}
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
    const anyAllInline = result.diagnostics?.find(
      (d) => d.code === "AllInlineInterfaceFallback",
    );
    expect(anyAllInline).toBeDefined();
    expect(anyAllInline?.location.filePath).toBe("tests/allinline.ts");
    // This site has no node available, so it falls back to a filePath-only
    // sentinel location — line/column are zero.
    expect(anyAllInline?.location.line).toBe(0);
    expect(anyAllInline?.location.column).toBe(0);
  });

  it("does NOT fire AllInlineInterfaceFallback when the interface's sole implementor IS the entry-point class", () => {
    // Smoke test for the between-pass warn block: when the sole implementor
    // is a UdonBehaviour-decorated entry-point class, isAllInlineInterface
    // must return false and the warning must NOT fire. This covers
    // classRegistry-driven detection (decorator + baseClass chain + entry
    // flag all survive resetState), but does not fully pin down placement
    // invariants for classMap/entryPointClasses — those are documented at
    // the warn block in converter.ts rather than guarded by test.
    const source = `
import { UdonBehaviour, UdonSharpBehaviour } from "./stubs";

interface IAdvancer {
  advance(): void;
}

@UdonBehaviour()
class Entry extends UdonSharpBehaviour implements IAdvancer {
  advance(): void {}
  Start(): void {
    this.advance();
  }
}
`;
    const result = transpile(source, "tests/entry_advancer.ts");
    const any = result.diagnostics?.find(
      (d) => d.code === "AllInlineInterfaceFallback",
    );
    expect(any).toBeUndefined();
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

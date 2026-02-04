/**
 * Unit tests for class registry
 */

import { describe, expect, it } from "vitest";
import { ClassRegistry } from "../../../src/transpiler/frontend/class_registry";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser";

describe("ClassRegistry", () => {
  it("should register entry points via decorators", () => {
    const parser = new TypeScriptParser();
    const source = `
      @UdonBehaviour()
      class Sample extends UdonSharpBehaviour {
        Start(): void {}
      }
    `;

    const program = parser.parse(source, "Sample.ts");
    const registry = new ClassRegistry();
    registry.registerFromProgram(program, "Sample.ts");

    const entryPoints = registry.getEntryPoints();
    expect(entryPoints).toHaveLength(1);
    expect(entryPoints[0]?.name).toBe("Sample");
    expect(entryPoints[0]?.baseClass).toBe("UdonSharpBehaviour");
  });
});

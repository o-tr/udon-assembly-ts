import { describe, expect, it } from "vitest";
import { ErrorCollector } from "../../../src/transpiler/errors/error_collector";
import { ClassRegistry } from "../../../src/transpiler/frontend/class_registry";
import { InheritanceValidator } from "../../../src/transpiler/frontend/inheritance_validator";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";

describe("interface validation", () => {
  it("reports missing members for implements", () => {
    const source = `
      interface IFoo {
        value: number;
        DoThing(): void;
      }

      class Foo implements IFoo {
        value: number = 1;
      }
    `;

    const errorCollector = new ErrorCollector();
    const parser = new TypeScriptParser(errorCollector);
    const ast = parser.parse(source, "iface.ts");

    const registry = new ClassRegistry();
    registry.registerFromProgram(ast, "iface.ts");

    const validator = new InheritanceValidator(registry, errorCollector);
    validator.validate("Foo");

    expect(errorCollector.hasErrors()).toBe(true);
  });
});

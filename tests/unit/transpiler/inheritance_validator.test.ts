/**
 * Unit tests for inheritance validation
 */

import { describe, expect, it } from "vitest";
import { ErrorCollector } from "../../../src/transpiler/errors/error_collector";
import { ClassRegistry } from "../../../src/transpiler/frontend/class_registry";
import { InheritanceValidator } from "../../../src/transpiler/frontend/inheritance_validator";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";

describe("InheritanceValidator", () => {
  it("should accept classes extending UdonSharpBehaviour", () => {
    const parser = new TypeScriptParser();
    const source = `
      @UdonBehaviour()
      class Good extends UdonSharpBehaviour {
        Start(): void {}
      }
    `;

    const program = parser.parse(source, "Good.ts");
    const registry = new ClassRegistry();
    registry.registerFromProgram(program, "Good.ts");

    const collector = new ErrorCollector();
    const validator = new InheritanceValidator(registry, collector);
    validator.validate("Good");

    expect(collector.hasErrors()).toBe(false);
  });

  it("should flag classes missing UdonSharpBehaviour inheritance", () => {
    const parser = new TypeScriptParser();
    const source = `
      @UdonBehaviour()
      class Bad {
        Start(): void {}
      }
    `;

    const program = parser.parse(source, "Bad.ts");
    const registry = new ClassRegistry();
    registry.registerFromProgram(program, "Bad.ts");

    const collector = new ErrorCollector();
    const validator = new InheritanceValidator(registry, collector);
    validator.validate("Bad");

    expect(collector.hasErrors()).toBe(true);
  });
});

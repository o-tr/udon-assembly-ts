import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import { TACInstructionKind } from "../../../src/transpiler/ir/tac_instruction";

const stringify = (tac: { toString(): string }[]) =>
  tac.map((inst) => inst.toString()).join("\n");

describe("FieldChangeCallback", () => {
  it("invokes callback after property assignment", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        @FieldChangeCallback("OnValueChanged")
        value: number = 0;

        OnValueChanged(): void {}

        Start(): void {
          this.value = 1;
        }
      }
    `;
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const tacText = stringify(tac);

    expect(tacText).toContain("OnValueChanged");
  });

  it("emits OnDeserialization with change detection", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        @FieldChangeCallback("OnValueChanged")
        value: number = 0;

        OnValueChanged(): void {}
      }
    `;
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);
    const tacText = stringify(tac);

    expect(tac.some((inst) => inst.kind === TACInstructionKind.Label)).toBe(
      true,
    );
    expect(tacText).toContain("_onDeserialization");
    expect(tacText).toContain("__prev_value");
  });
});

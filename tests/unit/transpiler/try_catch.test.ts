import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import { TACInstructionKind } from "../../../src/transpiler/ir/tac_instruction";

const stringify = (tac: { toString(): string }[]) =>
  tac.map((inst) => inst.toString()).join("\n");

describe("try/catch expansion", () => {
  it("inserts error flag and catch labels", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          try {
            this.SendCustomEvent("Ok");
          } catch (e) {
            this.SendCustomEvent("Fail");
          }
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

    expect(tacText).toContain("__error_flag_");
    expect(tac.some((inst) => inst.kind === TACInstructionKind.Label)).toBe(
      true,
    );
    expect(tacText).toContain("catch_");
  });

  it("handles throw by jumping to catch", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          try {
            throw 1;
          } catch (e) {
            this.SendCustomEvent("Thrown");
          }
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

    expect(tacText).toContain("goto catch_");
  });
});

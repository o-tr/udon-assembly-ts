import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac";

const stringify = (tac: { toString(): string }[]) =>
  tac.map((inst) => inst.toString()).join("\n");

describe("nameof/typeof", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("lowers nameof to string literal", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          const n: string = nameof(value);
        }
      }
    `;
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    expect(stringify(tac)).toContain('"value"');
  });

  it("lowers typeof to SystemType.GetType extern", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Demo {
        Start(): void {
          let value: number = 1;
          const t = typeof value;
        }
      }
    `;
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const udonConverter = new TACToUdonConverter();
    udonConverter.convert(tac);
    const externs = udonConverter.getExternSignatures();

    expect(
      externs.some((sig) =>
        sig.includes("SystemType.__GetType__SystemString__SystemType"),
      ),
    ).toBe(true);
  });
});

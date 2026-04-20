import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import { TACInstructionKind } from "../../../src/transpiler/ir/tac_instruction.js";

describe("expression lowering", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("handles conditional expressions", () => {
    const parser = new TypeScriptParser();
    const source = "let x: number = 5; let y: number = x > 0 ? x : -x;";
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const conditionalJump = tac.find(
      (inst) => inst.kind === TACInstructionKind.ConditionalJump,
    );
    expect(conditionalJump).toBeDefined();
  });

  it("handles null coalescing expressions", () => {
    const parser = new TypeScriptParser();
    const source =
      'let name: string = "Bob"; let value: string = name ?? "Unknown";';
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const equalityOp = tac.find(
      (inst) =>
        inst.kind === TACInstructionKind.BinaryOp &&
        inst.toString().includes("=="),
    );
    expect(equalityOp).toBeDefined();
  });

  it("generates Int32 extern signature for shift operators on number type", () => {
    const transpiler = new TypeScriptToUdonTranspiler();
    // Use a fractional literal so the float→Int32 truncation path is exercised
    // (Convert.ToInt32 rounds halves; Math.Truncate gives JS ToInt32 semantics).
    const source = `
      @UdonBehaviour()
      class ShiftTest extends UdonSharpBehaviour {
        Start(): void {
          let x: number = 1.9;
          let y: number = x >> 1;
          let z: number = x << 2;
        }
      }
    `;
    const { uasm } = transpiler.transpile(source);
    // Shift on number (SystemSingle) must use Int32 domain, never SystemSingle
    expect(uasm).not.toContain("SystemSingle.__op_RightShift__");
    expect(uasm).not.toContain("SystemSingle.__op_LeftShift__");
    const rightShiftSig = "op_RightShift__SystemInt32_SystemInt32__SystemInt32";
    const leftShiftSig = "op_LeftShift__SystemInt32_SystemInt32__SystemInt32";
    expect(uasm).toContain(rightShiftSig);
    expect(uasm).toContain(leftShiftSig);
    // Float→Int32 coercion must truncate, not round (Math.Truncate extern present)
    expect(uasm).toContain("__Truncate__");
  });

  it("handles template expressions", () => {
    const parser = new TypeScriptParser();
    const source = // biome-ignore lint/suspicious/noTemplateCurlyInString: for test
      "let score: number = 5; let msg: string = `Score: ${score}`;";
    const ast = parser.parse(source);
    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const concatCall = tac.find(
      (inst) =>
        inst.kind === TACInstructionKind.Call &&
        inst
          .toString()
          .includes(
            "SystemString.__Concat__SystemString_SystemString__SystemString",
          ),
    );
    expect(concatCall).toBeDefined();
  });
});

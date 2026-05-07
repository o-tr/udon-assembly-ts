import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
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

  describe("unsigned right shift (>>>)", () => {
    it("lowers >>> 0 to identity — no shift or mask instructions emitted", () => {
      const transpiler = new TypeScriptToUdonTranspiler();
      const source = `
        @UdonBehaviour()
        class UrsTest extends UdonSharpBehaviour {
          Start(): void {
            let x: number = 42;
            let y: number = x >>> 0;
          }
        }
      `;
      const { uasm, diagnostics } = transpiler.transpile(source);
      // Identity: no RightShift or LogicalAnd in UASM for the >>> 0 path
      expect(uasm).not.toContain("op_RightShift");
      expect(uasm).not.toContain("op_LogicalAnd");
      // No UnsupportedOperator warning for constant shift-by-zero
      const unsupported = (diagnostics ?? []).filter(
        (w) => w.code === "UnsupportedOperator",
      );
      expect(unsupported).toHaveLength(0);
    });

    it("lowers >>> 1 to (x >> 1) & 0x7FFFFFFF — unsigned binary-search midpoint", () => {
      const transpiler = new TypeScriptToUdonTranspiler();
      const source = `
        @UdonBehaviour()
        class UrsTest extends UdonSharpBehaviour {
          Start(): void {
            let lo: number = 0;
            let hi: number = 2147483646;
            let mid: number = (lo + hi) >>> 1;
          }
        }
      `;
      const { uasm } = transpiler.transpile(source);
      // Must use Int32 signed right shift
      expect(uasm).toContain(
        "op_RightShift__SystemInt32_SystemInt32__SystemInt32",
      );
      // Must mask the sign-extension bits
      expect(uasm).toContain(
        "op_LogicalAnd__SystemInt32_SystemInt32__SystemInt32",
      );
      // Must NOT emit the old UnsupportedOperator-triggered signed-only shift
      // (the mask is the distinguishing signal; we checked LogicalAnd above)
    });

    it("lowers >>> 2 to (x >> 2) & 0x3FFFFFFF", () => {
      const transpiler = new TypeScriptToUdonTranspiler();
      const source = `
        @UdonBehaviour()
        class UrsTest extends UdonSharpBehaviour {
          Start(): void {
            let x: number = -8;
            let y: number = x >>> 2;
          }
        }
      `;
      const { uasm } = transpiler.transpile(source);
      expect(uasm).toContain(
        "op_RightShift__SystemInt32_SystemInt32__SystemInt32",
      );
      expect(uasm).toContain(
        "op_LogicalAnd__SystemInt32_SystemInt32__SystemInt32",
      );
      // 0x3FFFFFFF = 1073741823 — the mask constant must appear in the heap data
      expect(uasm).toContain("1073741823");
    });

    it("does not emit UnsupportedOperator warning for constant shifts", () => {
      // All four production sites in mahjong-t2 use constant shift amounts.
      const transpiler = new TypeScriptToUdonTranspiler();
      const source = `
        @UdonBehaviour()
        class UrsTest extends UdonSharpBehaviour {
          @field() state: number = 0;
          Start(): void {
            let seed: number = 12345;
            let a: number = seed >>> 0;
            let b: number = seed >>> 1;
            let c: number = this.state >>> 0;
          }
        }
      `;
      const { diagnostics } = transpiler.transpile(source);
      const unsupportedWarnings = (diagnostics ?? []).filter(
        (w) => w.code === "UnsupportedOperator",
      );
      expect(unsupportedWarnings).toHaveLength(0);
    });
  });
});

/**
 * Unit tests for Udon code generation
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TACToUdonConverter } from "../../../src/transpiler/codegen/tac_to_udon/index.js";
import { UdonAssembler } from "../../../src/transpiler/codegen/udon_assembler";
import {
  JumpIfFalseInstruction,
  JumpInstruction,
  LabelInstruction,
  UdonInstructionKind,
} from "../../../src/transpiler/codegen/udon_instruction";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";

describe("Udon Code Generation", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("should generate Udon instructions for variable assignment", () => {
    const parser = new TypeScriptParser();
    const source = "let x: number = 10;";
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const udonConverter = new TACToUdonConverter();
    const udon = udonConverter.convert(tac);

    // Should have PUSH and COPY instructions
    expect(udon.length).toBeGreaterThan(0);
    const pushes = udon.filter(
      (inst) => inst.kind === UdonInstructionKind.Push,
    );
    expect(pushes.length).toBeGreaterThan(0);

    const copies = udon.filter(
      (inst) => inst.kind === UdonInstructionKind.Copy,
    );
    expect(copies.length).toBeGreaterThan(0);
  });

  it("should generate Udon instructions for binary operations", () => {
    const parser = new TypeScriptParser();
    const source = "let result: number = 5 + 3;";
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const udonConverter = new TACToUdonConverter();
    const udon = udonConverter.convert(tac);
    const externs = udonConverter.getExternSignatures();

    // Should have EXTERN for Add operation
    expect(externs.length).toBeGreaterThan(0);
    expect(externs.some((sig) => sig.includes("Add"))).toBe(true);

    const externInsts = udon.filter(
      (inst) => inst.kind === UdonInstructionKind.Extern,
    );
    expect(externInsts.length).toBeGreaterThan(0);
  });

  it("should intern extern signatures into data section", () => {
    const parser = new TypeScriptParser();
    const source = `
      let x: number = 1 + 2;
      let y: number = 3 + 4;
    `;
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const udonConverter = new TACToUdonConverter();
    const udon = udonConverter.convert(tac);
    const externs = udonConverter.getExternSignatures();
    const dataSection = udonConverter.getDataSectionWithTypes();

    const assembler = new UdonAssembler();
    const uasm = assembler.assemble(udon, externs, dataSection);

    const externEntries = dataSection.filter(([name]) =>
      name.startsWith("__extern_"),
    );
    expect(externEntries.length).toBe(1);
    expect(String(externEntries[0][3])).toContain("op_Addition");
    expect(uasm).toContain("EXTERN, __extern_");
  });

  it("should generate Udon instructions for conditionals", () => {
    const parser = new TypeScriptParser();
    const source = `
      let x: number = 10;
      if (x < 20) {
        let y: number = 5;
      }
    `;
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const udonConverter = new TACToUdonConverter();
    const udon = udonConverter.convert(tac);

    // Should have JUMP_IF_FALSE and labels
    const jumpIfFalse = udon.filter(
      (inst) => inst.kind === UdonInstructionKind.JumpIfFalse,
    );
    expect(jumpIfFalse.length).toBeGreaterThan(0);

    const labels = udon.filter(
      (inst) => inst.kind === UdonInstructionKind.Label,
    );
    expect(labels.length).toBeGreaterThan(0);
  });

  it("should generate extern signatures for comparison operators", () => {
    const parser = new TypeScriptParser();
    const source = "let result: boolean = 10 < 20;";
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const udonConverter = new TACToUdonConverter();
    udonConverter.convert(tac);
    const externs = udonConverter.getExternSignatures();

    // Should have LessThan extern
    expect(externs.some((sig) => sig.includes("LessThan"))).toBe(true);
  });

  it("should generate array access externs", () => {
    const parser = new TypeScriptParser();
    const source = `
      let arr: number[] = [];
      arr = [1, 2];
      let x: number = arr[1];
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
      externs.some(
        (sig) =>
          sig.includes("SystemArray.__Get__SystemInt32") ||
          sig.includes("SingleArray.__Get__SystemInt32"),
      ),
    ).toBe(true);
  });

  it("should map extern constructor signatures", () => {
    const parser = new TypeScriptParser();
    const source = `
      const pos = new Vector3(1, 2, 3);
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
        sig.includes(
          "UnityEngineVector3.__ctor__SystemSingle_SystemSingle_SystemSingle__UnityEngineVector3",
        ),
      ),
    ).toBe(true);
  });
});

describe("Udon Assembler", () => {
  it("should generate .uasm file with data and code sections", () => {
    const parser = new TypeScriptParser();
    const source = "let x: number = 10;";
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const udonConverter = new TACToUdonConverter();
    const udon = udonConverter.convert(tac);
    const externs = udonConverter.getExternSignatures();
    const dataSection = udonConverter.getDataSectionWithTypes();

    const assembler = new UdonAssembler();
    const uasm = assembler.assemble(udon, externs, dataSection);

    // Should contain .data_start and .data_end
    expect(uasm).toContain(".data_start");
    expect(uasm).toContain(".data_end");

    // Should contain .code_start and .code_end
    expect(uasm).toContain(".code_start");
    expect(uasm).toContain(".code_end");
  });

  it("should include variable declarations in data section", () => {
    const parser = new TypeScriptParser();
    const source = "let result: number = 5 + 3;";
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const udonConverter = new TACToUdonConverter();
    const udon = udonConverter.convert(tac);
    const externs = udonConverter.getExternSignatures();
    const dataSectionWithTypes = udonConverter.getDataSectionWithTypes();

    const assembler = new UdonAssembler();
    const uasm = assembler.assemble(udon, externs, dataSectionWithTypes);

    // Should contain variable declarations with type and value
    expect(uasm).toContain(": %System");
    expect(uasm).toContain(".export");
    expect(uasm).toContain(".sync");
  });

  it("should generate PUSH and COPY instructions in code section", () => {
    const parser = new TypeScriptParser();
    const source = "let x: number = 10;";
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(parser.getSymbolTable());
    const tac = converter.convert(ast);

    const udonConverter = new TACToUdonConverter();
    const udon = udonConverter.convert(tac);
    const externs = udonConverter.getExternSignatures();
    const dataSectionWithTypes = udonConverter.getDataSectionWithTypes();

    const assembler = new UdonAssembler();
    const uasm = assembler.assemble(udon, externs, dataSectionWithTypes);

    // Should contain PUSH and COPY instructions with comma separator
    expect(uasm).toContain("PUSH,");
    expect(uasm).toContain("COPY");
  });

  it("should avoid helper data name collisions for restricted type init", () => {
    const assembler = new UdonAssembler();
    const instructions = [
      new LabelInstruction("_start"),
      new JumpInstruction(0xfffffffc),
    ];
    const dataSection: Array<[string, number, string, unknown]> = [
      ["__asm_restrict_int32_0", 0, "Int32", 123],
      ["__asm_restrict_eq_extern", 1, "String", "user_defined"],
      ["flag", 2, "Boolean", true],
    ];

    const uasm = assembler.assemble(instructions, [], dataSection);

    expect(uasm).toMatch(/__asm_restrict_int32_0_\d+: %SystemInt32, 0/);
    expect(uasm).toMatch(
      /__asm_restrict_eq_extern_\d+: %SystemString, "SystemInt32.__op_Equality__SystemInt32_SystemInt32__SystemBoolean"/,
    );
    expect(uasm).toMatch(/PUSH, __asm_restrict_int32_0_\d+/);
    expect(uasm).toMatch(/EXTERN, __asm_restrict_eq_extern_\d+/);
  });

  it("should resolve hex-looking jump labels and reserve numeric jumps for literal addresses", () => {
    const assembler = new UdonAssembler();
    const instructions = [
      new LabelInstruction("_start"),
      new JumpIfFalseInstruction("0x10"),
      new JumpInstruction("0x10"),
      new LabelInstruction("0x10"),
      new JumpInstruction(0xfffffffc),
    ];

    const uasm = assembler.assemble(instructions, [], []);

    expect(uasm).toContain("JUMP_IF_FALSE, 0x00000010");
    expect(uasm).toContain("JUMP, 0x00000010");
    expect(uasm).toContain("JUMP, 0xFFFFFFFC");
  });
});

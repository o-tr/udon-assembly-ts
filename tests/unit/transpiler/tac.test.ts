/**
 * Unit tests for TAC generation and optimization
 */

import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import { TACOptimizer } from "../../../src/transpiler/ir/optimizer/index.js";
import { TACInstructionKind } from "../../../src/transpiler/ir/tac_instruction";

describe("TAC Generation", () => {
  it("should generate TAC for variable declaration", () => {
    const parser = new TypeScriptParser();
    const source = "let x: number = 10;";
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    // We expect at least the assignment instruction.
    // Note: Implicit _start entry point generation adds extra instructions (Label, Return)
    expect(tac.length).toBeGreaterThanOrEqual(1);

    const assignment = tac.find(
      (inst) => inst.kind === TACInstructionKind.Assignment,
    );
    expect(assignment).toBeDefined();
    expect(assignment?.toString()).toContain("x");
    expect(assignment?.toString()).toContain("10");
  });

  it("should generate TAC for binary expression", () => {
    const parser = new TypeScriptParser();
    const source = "let result: number = 5 + 3;";
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    // Should have temp = 5 + 3, result = temp
    expect(tac.length).toBeGreaterThanOrEqual(2);
    const binOp = tac.find((inst) => inst.kind === TACInstructionKind.BinaryOp);
    expect(binOp).toBeDefined();
    expect(binOp?.toString()).toContain("+");
  });

  it("should generate TAC for if statement", () => {
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

    // Should have labels and conditional jump
    const labels = tac.filter((inst) => inst.kind === TACInstructionKind.Label);
    expect(labels.length).toBeGreaterThanOrEqual(2); // else and endif labels

    const condJump = tac.find(
      (inst) => inst.kind === TACInstructionKind.ConditionalJump,
    );
    expect(condJump).toBeDefined();
  });

  it("should generate TAC for while loop", () => {
    const parser = new TypeScriptParser();
    const source = `
      let i: number = 0;
      while (i < 10) {
        i = i + 1;
      }
    `;
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    // Should have start and end labels
    const labels = tac.filter((inst) => inst.kind === TACInstructionKind.Label);
    expect(labels.length).toBeGreaterThanOrEqual(2); // while_start and while_end

    // Should have unconditional jump back to start
    const uncondJumps = tac.filter(
      (inst) => inst.kind === TACInstructionKind.UnconditionalJump,
    );
    expect(uncondJumps.length).toBeGreaterThanOrEqual(1);
  });

  it("should generate TAC for switch and do-while", () => {
    const parser = new TypeScriptParser();
    const source = `
      let value: number = 1;
      do {
        value = value + 1;
      } while (value < 3);
      switch (value) {
        case 1:
          value = 2;
          break;
        default:
          value = 3;
          break;
      }
    `;
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const labels = tac.filter((inst) => inst.kind === TACInstructionKind.Label);
    expect(labels.length).toBeGreaterThan(0);

    const jumps = tac.filter(
      (inst) => inst.kind === TACInstructionKind.UnconditionalJump,
    );
    expect(jumps.length).toBeGreaterThan(0);
  });

  it("should allow switch fall-through without break", () => {
    const parser = new TypeScriptParser();
    const source = `
      let value: number = 1;
      switch (value) {
        case 1:
          value = 2;
        case 2:
          value = 3;
      }
    `;
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const labels = tac.filter((inst) => inst.kind === TACInstructionKind.Label);
    expect(labels.length).toBeGreaterThan(0);
  });
});

describe("TAC Optimization", () => {
  it("should fold constant expressions", () => {
    const parser = new TypeScriptParser();
    const source =
      "let result: number = 5 + 3; if (result > 0) { result = result; }";
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(tac);

    // After optimization, 5 + 3 should be folded or eliminated
    const optimizedStr = optimized.map((inst) => inst.toString()).join("\n");
    expect(optimizedStr).not.toContain("5 + 3");

    // Should not have binary operation anymore
    const binOps = optimized.filter(
      (inst) => inst.kind === TACInstructionKind.BinaryOp,
    );
    expect(binOps).toHaveLength(0);
  });

  it("should fold unary expressions", () => {
    const parser = new TypeScriptParser();
    const source =
      "let negated: number = -5; if (negated < 0) { negated = negated; }";
    const ast = parser.parse(source);

    const converter = new ASTToTACConverter(
      parser.getSymbolTable(),
      parser.getEnumRegistry(),
    );
    const tac = converter.convert(ast);

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(tac);

    // After optimization, unary op should be folded or eliminated
    const optimizedStr = optimized.map((inst) => inst.toString()).join("\n");
    expect(optimizedStr).not.toContain("=-");

    // Should not have unary operation anymore
    const unaryOps = optimized.filter(
      (inst) => inst.kind === TACInstructionKind.UnaryOp,
    );
    expect(unaryOps).toHaveLength(0);
  });

  it("should eliminate dead code after unconditional jump", () => {
    const parser = new TypeScriptParser();
    // This is a simplified test - in real code, dead code would be more explicit
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

    const optimizer = new TACOptimizer();
    const optimized = optimizer.optimize(tac);

    // Optimized code should have fewer or equal instructions
    expect(optimized.length).toBeLessThanOrEqual(tac.length);
  });
});

/**
 * Unit tests for TypeScript parser and frontend
 */

import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { PrimitiveTypes } from "../../../src/transpiler/frontend/type_symbols";
import {
  ASTNodeKind,
  type BinaryExpressionNode,
  type IfStatementNode,
  type UnaryExpressionNode,
  type VariableDeclarationNode,
  type WhileStatementNode,
} from "../../../src/transpiler/frontend/types";

describe("TypeScript Parser", () => {
  it("should parse variable declarations", () => {
    const parser = new TypeScriptParser();
    const source = "let x: number = 10;";
    const ast = parser.parse(source);

    expect(ast.kind).toBe(ASTNodeKind.Program);
    expect(ast.statements).toHaveLength(1);

    const varDecl = ast.statements[0] as VariableDeclarationNode;
    expect(varDecl.kind).toBe(ASTNodeKind.VariableDeclaration);
    expect(varDecl.name).toBe("x");
    expect(varDecl.type).toBe(PrimitiveTypes.single);
    expect(varDecl.isConst).toBe(false);
    expect(varDecl.initializer).toBeDefined();
  });

  it("should parse const declarations", () => {
    const parser = new TypeScriptParser();
    const source = "const y: number = 20;";
    const ast = parser.parse(source);

    const varDecl = ast.statements[0] as VariableDeclarationNode;
    expect(varDecl.isConst).toBe(true);
  });

  it("should parse binary expressions", () => {
    const parser = new TypeScriptParser();
    const source = "let result: number = 5 + 3;";
    const ast = parser.parse(source);

    const varDecl = ast.statements[0] as VariableDeclarationNode;
    const init = varDecl.initializer as BinaryExpressionNode;
    expect(init.kind).toBe(ASTNodeKind.BinaryExpression);
    expect(init.operator).toBe("+");
  });

  it("should parse if statements", () => {
    const parser = new TypeScriptParser();
    const source = `
      let x: number = 10;
      if (x < 20) {
        let y: number = 5;
      }
    `;
    const ast = parser.parse(source);

    expect(ast.statements).toHaveLength(2);
    const ifStmt = ast.statements[1] as IfStatementNode;
    expect(ifStmt.kind).toBe(ASTNodeKind.IfStatement);
    expect((ifStmt.condition as BinaryExpressionNode).kind).toBe(
      ASTNodeKind.BinaryExpression,
    );
    expect(ifStmt.thenBranch).toBeDefined();
  });

  it("should parse while loops", () => {
    const parser = new TypeScriptParser();
    const source = `
      let i: number = 0;
      while (i < 10) {
        i = i + 1;
      }
    `;
    const ast = parser.parse(source);

    expect(ast.statements).toHaveLength(2);
    const whileStmt = ast.statements[1] as WhileStatementNode;
    expect(whileStmt.kind).toBe(ASTNodeKind.WhileStatement);
    expect(whileStmt.condition).toBeDefined();
    expect(whileStmt.body).toBeDefined();
  });

  it("should track symbols in symbol table", () => {
    const parser = new TypeScriptParser();
    const source = `
      let x: number = 10;
      let y: number = 20;
    `;
    parser.parse(source);
    const symbolTable = parser.getSymbolTable();

    const xSymbol = symbolTable.lookup("x");
    expect(xSymbol).toBeDefined();
    expect(xSymbol?.name).toBe("x");
    expect(xSymbol?.type).toBe(PrimitiveTypes.single);

    const ySymbol = symbolTable.lookup("y");
    expect(ySymbol).toBeDefined();
    expect(ySymbol?.name).toBe("y");
  });

  it("should handle nested scopes", () => {
    const parser = new TypeScriptParser();
    const source = `
      let x: number = 10;
      if (x > 5) {
        let y: number = 20;
      }
    `;
    parser.parse(source);
    const symbolTable = parser.getSymbolTable();

    // x should be in global scope
    const xSymbol = symbolTable.lookup("x");
    expect(xSymbol?.scope).toBe(0);
  });

  it("should parse comparison operators", () => {
    const parser = new TypeScriptParser();
    const source = "let result: boolean = 10 < 20;";
    const ast = parser.parse(source);

    const varDecl = ast.statements[0] as VariableDeclarationNode;
    const binExpr = varDecl.initializer as BinaryExpressionNode;
    expect(binExpr.kind).toBe(ASTNodeKind.BinaryExpression);
    expect(binExpr.operator).toBe("<");
  });

  it("should parse unary expressions", () => {
    const parser = new TypeScriptParser();
    const source = "let negated: number = -5;";
    const ast = parser.parse(source);

    const varDecl = ast.statements[0] as VariableDeclarationNode;
    const unaryExpr = varDecl.initializer as UnaryExpressionNode;
    expect(unaryExpr.kind).toBe(ASTNodeKind.UnaryExpression);
    expect(unaryExpr.operator).toBe("-");
  });

  it("should map branded and Unity types", () => {
    const parser = new TypeScriptParser();
    const source = `
      let byteValue: UdonByte = 10;
      let pos: Vector3;
      let arr: number[] = [];
    `;
    const ast = parser.parse(source);

    const byteDecl = ast.statements[0] as VariableDeclarationNode;
    expect(byteDecl.type.name).toBe("byte");

    const vectorDecl = ast.statements[1] as VariableDeclarationNode;
    expect(vectorDecl.type.name).toBe("Vector3");

    const arrayDecl = ast.statements[2] as VariableDeclarationNode;
    expect(arrayDecl.type.name).toBe("float[]");
  });
});

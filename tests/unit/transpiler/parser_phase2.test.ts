/**
 * Unit tests for Phase 2 parser extensions
 */

import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser";
import {
  ASTNodeKind,
  type AssignmentExpressionNode,
  type ClassDeclarationNode,
  type ForStatementNode,
  type MethodDeclarationNode,
  type PropertyAccessExpressionNode,
  type PropertyDeclarationNode,
} from "../../../src/transpiler/frontend/types";

describe("TypeScript Parser Phase 2", () => {
  it("should parse class declarations with decorators, properties, and methods", () => {
    const parser = new TypeScriptParser();
    const source = `
      @UdonBehaviour()
      class Sample extends UdonSharpBehaviour {
        public value: number = 1;
        Start(): void {
          for (let i: number = 0; i < 3; i = i + 1) {
            this.value = this.value + 1;
          }
        }
      }
    `;

    const ast = parser.parse(source);
    expect(ast.statements).toHaveLength(1);

    const classDecl = ast.statements[0] as ClassDeclarationNode;
    expect(classDecl.kind).toBe(ASTNodeKind.ClassDeclaration);
    expect(classDecl.name).toBe("Sample");
    expect(classDecl.baseClass).toBe("UdonSharpBehaviour");
    expect(classDecl.decorators).toHaveLength(1);
    expect(classDecl.decorators[0]?.name).toBe("UdonBehaviour");

    const prop = classDecl.properties[0] as PropertyDeclarationNode;
    expect(prop.name).toBe("value");

    const method = classDecl.methods[0] as MethodDeclarationNode;
    expect(method.name).toBe("Start");

    const forStmt = method.body.statements[0] as ForStatementNode;
    expect(forStmt.kind).toBe(ASTNodeKind.ForStatement);
  });

  it("should parse property access and assignment inside methods", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Sample extends UdonSharpBehaviour {
        Start(): void {
          this.value = this.value + 1;
        }
      }
    `;

    const ast = parser.parse(source);
    const classDecl = ast.statements[0] as ClassDeclarationNode;
    const method = classDecl.methods[0] as MethodDeclarationNode;
    const assignment = method.body.statements[0] as AssignmentExpressionNode;

    expect(assignment.kind).toBe(ASTNodeKind.AssignmentExpression);
    const target = assignment.target as PropertyAccessExpressionNode;
    expect(target.kind).toBe(ASTNodeKind.PropertyAccessExpression);
    expect(target.property).toBe("value");
  });

  it("should parse sync decorators on properties", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Sample {
        @UdonSynced("Linear")
        value: number = 10;
        @FieldChangeCallback("OnValueChanged")
        other: number = 5;
      }
    `;

    const ast = parser.parse(source);
    const classDecl = ast.statements[0] as ClassDeclarationNode;
    const props = classDecl.properties;
    expect(props[0]?.syncMode).toBe("Linear");
    expect(props[1]?.fieldChangeCallback).toBe("OnValueChanged");
  });
});

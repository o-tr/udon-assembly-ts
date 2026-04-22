import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { TypeCheckerContext } from "../../../src/transpiler/frontend/type_checker_context.js";
import {
  ASTNodeKind,
  type ClassDeclarationNode,
} from "../../../src/transpiler/frontend/types.js";

describe("TypeCheckerContext bridge", () => {
  it("resolves ts.Node from cloned AST nodes via stable node id", () => {
    const filePath = "/virtual/bridge_clone.ts";
    const source = `
      class Sample {
        Start(): void {
          const n: number = 1;
        }
      }
    `;
    const context = TypeCheckerContext.create({
      rootNames: [filePath],
      inMemorySources: { [filePath]: source },
    });
    const parser = new TypeScriptParser(undefined, context);
    const ast = parser.parse(source, filePath);
    const classNode = ast.statements.find(
      (stmt): stmt is ClassDeclarationNode =>
        stmt.kind === ASTNodeKind.ClassDeclaration,
    );
    expect(classNode).toBeDefined();

    const cloned = { ...(classNode as ClassDeclarationNode) };
    const resolved = context.resolveTsNode(cloned);
    expect(resolved).toBeDefined();
    expect(ts.isClassDeclaration(resolved as ts.Node)).toBe(true);
  });

  it("binds parser nodes to the checker program source file", () => {
    const filePath = "/virtual/bridge_program.ts";
    const source = `
      class EntryPoint {
        Start(): void {
          return;
        }
      }
    `;
    const context = TypeCheckerContext.create({
      rootNames: [filePath],
      inMemorySources: { [filePath]: source },
    });
    const parser = new TypeScriptParser(undefined, context);
    const ast = parser.parse(source, filePath);
    const classNode = ast.statements.find(
      (stmt): stmt is ClassDeclarationNode =>
        stmt.kind === ASTNodeKind.ClassDeclaration,
    );
    expect(classNode).toBeDefined();

    const resolved = context.resolveTsNode(classNode as ClassDeclarationNode);
    expect(resolved).toBeDefined();
    expect(resolved?.getSourceFile()).toBe(context.getSourceFile(filePath));
  });
});

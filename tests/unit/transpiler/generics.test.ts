import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { GenericTypeParameterSymbol } from "../../../src/transpiler/frontend/type_symbols";
import {
  ASTNodeKind,
  type ClassDeclarationNode,
} from "../../../src/transpiler/frontend/types";

describe("generic type parameters", () => {
  it("maps class type parameters to GenericTypeParameterSymbol", () => {
    const parser = new TypeScriptParser();
    const source = `
      class Box<T> {
        value: T;
      }
    `;
    const ast = parser.parse(source);
    const classDecl = ast.statements[0] as ClassDeclarationNode;

    expect(classDecl.kind).toBe(ASTNodeKind.ClassDeclaration);
    const prop = classDecl.properties[0];
    expect(prop.type).toBeInstanceOf(GenericTypeParameterSymbol);
  });
});

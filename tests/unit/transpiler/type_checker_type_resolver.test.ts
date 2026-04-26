import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { TypeCheckerContext } from "../../../src/transpiler/frontend/type_checker_context.js";
import {
  createTypeCheckerTypeResolver,
  type TypeCheckerTypeResolver,
} from "../../../src/transpiler/frontend/type_checker_type_resolver.js";
import { TypeMapper } from "../../../src/transpiler/frontend/type_mapper.js";
import {
  ArrayTypeSymbol,
  InterfaceTypeSymbol,
  ObjectType,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols.js";
import {
  ASTNodeKind,
  type ClassDeclarationNode,
  type MethodDeclarationNode,
  type VariableDeclarationNode,
} from "../../../src/transpiler/frontend/types.js";

function findNode<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T {
  let found: T | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) {
    throw new Error("Expected node not found");
  }
  return found;
}

function createResolverFromSource(
  source: string,
  filePath: string,
): { context: TypeCheckerContext; resolver: TypeCheckerTypeResolver } {
  const context = TypeCheckerContext.create({
    rootNames: [filePath],
    inMemorySources: { [filePath]: source },
  });
  const resolver = createTypeCheckerTypeResolver(context, new TypeMapper());
  return { context, resolver };
}

describe("TypeCheckerTypeResolver", () => {
  it("resolves inferred primitive types from ts.Node", () => {
    const filePath = "/virtual/type_resolver_number.ts";
    const source = "const n = 1;";
    const { context, resolver } = createResolverFromSource(source, filePath);
    const sourceFile = context.getSourceFile(filePath);
    expect(sourceFile).toBeDefined();
    const declaration = findNode(
      sourceFile as ts.SourceFile,
      ts.isVariableDeclaration,
    );
    const resolved = resolver.resolveFromTsNode(declaration.name);
    expect(resolved).toBe(PrimitiveTypes.single);
  });

  it("resolves inferred array element types from ts.Node", () => {
    const filePath = "/virtual/type_resolver_array.ts";
    const source = "const xs = [1, 2, 3];";
    const { context, resolver } = createResolverFromSource(source, filePath);
    const sourceFile = context.getSourceFile(filePath);
    expect(sourceFile).toBeDefined();
    const declaration = findNode(
      sourceFile as ts.SourceFile,
      ts.isVariableDeclaration,
    );
    const resolved = resolver.resolveFromTsNode(declaration.name);
    expect(resolved).toBeInstanceOf(ArrayTypeSymbol);
    expect((resolved as ArrayTypeSymbol).elementType).toBe(
      PrimitiveTypes.single,
    );
  });

  it("removes nullish members when union resolves to single non-null type", () => {
    const filePath = "/virtual/type_resolver_union.ts";
    const source = 'let s: string | null = "a";';
    const { context, resolver } = createResolverFromSource(source, filePath);
    const sourceFile = context.getSourceFile(filePath);
    expect(sourceFile).toBeDefined();
    const declaration = findNode(
      sourceFile as ts.SourceFile,
      ts.isVariableDeclaration,
    );
    const resolved = resolver.resolveFromTsNode(declaration.name);
    expect(resolved).toBe(PrimitiveTypes.string);
  });

  it("resolves from bridged custom AST nodes", () => {
    const filePath = "/virtual/type_resolver_ast_bridge.ts";
    const source = `
      class EntryPoint {
        Start(): void {
          const ok = true;
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
    const method = (classNode as ClassDeclarationNode).methods.find(
      (candidate): candidate is MethodDeclarationNode =>
        candidate.name === "Start",
    );
    expect(method).toBeDefined();
    const declaration = (method as MethodDeclarationNode).body
      .statements[0] as VariableDeclarationNode;
    const resolver = createTypeCheckerTypeResolver(context, parser.typeMapper);
    const resolved = resolver.resolveFromAstNode(
      declaration.initializer as NonNullable<
        VariableDeclarationNode["initializer"]
      >,
      context,
    );
    expect(resolved).toBe(PrimitiveTypes.boolean);
  });

  it("collapses arrow function types to ObjectType (step A)", () => {
    const filePath = "/virtual/type_resolver_arrow_fn.ts";
    const source = "const f: (x: number) => string = (x) => x.toString();";
    const { context, resolver } = createResolverFromSource(source, filePath);
    const sourceFile = context.getSourceFile(filePath);
    expect(sourceFile).toBeDefined();
    const declaration = findNode(
      sourceFile as ts.SourceFile,
      ts.isVariableDeclaration,
    );
    const resolved = resolver.resolveFromTsNode(declaration.name);
    expect(resolved).toBe(ObjectType);
  });

  it("collapses Array.map callback parameter types to ObjectType (step A)", () => {
    const filePath = "/virtual/type_resolver_array_map_cb.ts";
    const source = `
      const xs = [1, 2, 3];
      xs.map((value, index) => value + index);
    `;
    const { context, resolver } = createResolverFromSource(source, filePath);
    const sourceFile = context.getSourceFile(filePath);
    expect(sourceFile).toBeDefined();
    const arrow = findNode(
      sourceFile as ts.SourceFile,
      ts.isArrowFunction,
    );
    const callback = (arrow.parent as ts.CallExpression).arguments[0];
    const resolved = resolver.resolveFromTsNode(callback);
    expect(resolved).toBe(ObjectType);
  });

  it("collapses construct-only anonymous types to ObjectType (step A)", () => {
    const filePath = "/virtual/type_resolver_construct_only.ts";
    const source = `
      class Foo {}
      declare const Ctor: new (x: number) => Foo;
    `;
    const { context, resolver } = createResolverFromSource(source, filePath);
    const sourceFile = context.getSourceFile(filePath);
    expect(sourceFile).toBeDefined();
    const declaration = findNode(
      sourceFile as ts.SourceFile,
      (n): n is ts.VariableDeclaration =>
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "Ctor",
    );
    const resolved = resolver.resolveFromTsNode(declaration.name);
    expect(resolved).toBe(ObjectType);
  });

  it("does not collapse symbol-backed callable interfaces (step A negative)", () => {
    const filePath = "/virtual/type_resolver_callable_iface.ts";
    const source = `
      interface F { (x: number): string }
      declare const f: F;
    `;
    const { context, resolver } = createResolverFromSource(source, filePath);
    const sourceFile = context.getSourceFile(filePath);
    expect(sourceFile).toBeDefined();
    const declaration = findNode(
      sourceFile as ts.SourceFile,
      (n): n is ts.VariableDeclaration =>
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "f",
    );
    const resolved = resolver.resolveFromTsNode(declaration.name);
    expect(resolved).toBeInstanceOf(InterfaceTypeSymbol);
    expect((resolved as InterfaceTypeSymbol).name).toBe("F");
  });

  it("preserves anonymous callable types that also have properties (step A negative)", () => {
    const filePath = "/virtual/type_resolver_callable_with_props.ts";
    const source = `
      declare const f: { (): void; foo: string };
    `;
    const { context, resolver } = createResolverFromSource(source, filePath);
    const sourceFile = context.getSourceFile(filePath);
    expect(sourceFile).toBeDefined();
    const declaration = findNode(
      sourceFile as ts.SourceFile,
      (n): n is ts.VariableDeclaration =>
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "f",
    );
    const resolved = resolver.resolveFromTsNode(declaration.name);
    expect(resolved).toBeInstanceOf(InterfaceTypeSymbol);
    expect((resolved as InterfaceTypeSymbol).properties.has("foo")).toBe(true);
  });

  it("collapses any to ObjectType (step B)", () => {
    const filePath = "/virtual/type_resolver_any.ts";
    const source = "let x: any;";
    const { context, resolver } = createResolverFromSource(source, filePath);
    const sourceFile = context.getSourceFile(filePath);
    expect(sourceFile).toBeDefined();
    const declaration = findNode(
      sourceFile as ts.SourceFile,
      ts.isVariableDeclaration,
    );
    const resolved = resolver.resolveFromTsNode(declaration.name);
    expect(resolved).toBe(ObjectType);
  });

  it("collapses unknown to ObjectType (step B)", () => {
    const filePath = "/virtual/type_resolver_unknown.ts";
    const source = "let x: unknown;";
    const { context, resolver } = createResolverFromSource(source, filePath);
    const sourceFile = context.getSourceFile(filePath);
    expect(sourceFile).toBeDefined();
    const declaration = findNode(
      sourceFile as ts.SourceFile,
      ts.isVariableDeclaration,
    );
    const resolved = resolver.resolveFromTsNode(declaration.name);
    expect(resolved).toBe(ObjectType);
  });

  it("collapses never return type to ObjectType (step B)", () => {
    const filePath = "/virtual/type_resolver_never.ts";
    const source = `function f(): never { throw new Error("x"); }`;
    const { context, resolver } = createResolverFromSource(source, filePath);
    const sourceFile = context.getSourceFile(filePath);
    expect(sourceFile).toBeDefined();
    const fn = findNode(
      sourceFile as ts.SourceFile,
      ts.isFunctionDeclaration,
    );
    const returnTypeNode = fn.type;
    expect(returnTypeNode).toBeDefined();
    const resolved = resolver.resolveFromTsNode(
      returnTypeNode as ts.TypeNode,
    );
    expect(resolved).toBe(ObjectType);
  });
});

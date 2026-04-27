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
  ExternTypes,
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

function findVariableDeclarationByName(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration {
  return findNode<ts.VariableDeclaration>(
    sourceFile,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name,
  );
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
    const arrow = findNode(sourceFile as ts.SourceFile, ts.isArrowFunction);
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
    const fn = findNode(sourceFile as ts.SourceFile, ts.isFunctionDeclaration);
    const returnTypeNode = fn.type;
    expect(returnTypeNode).toBeDefined();
    const resolved = resolver.resolveFromTsNode(returnTypeNode as ts.TypeNode);
    expect(resolved).toBe(ObjectType);
  });

  describe("interface caching and builtin shortcuts", () => {
    it("widens lib Map<K,V> to ExternTypes.dataDictionary via the builtin shortcut", () => {
      const filePath = "/virtual/type_resolver_lib_map.ts";
      const source = "let m: Map<string, number> = new Map();";
      const { context, resolver } = createResolverFromSource(source, filePath);
      const sourceFile = context.getSourceFile(filePath);
      expect(sourceFile).toBeDefined();
      const declaration = findNode(
        sourceFile as ts.SourceFile,
        ts.isVariableDeclaration,
      );
      const resolved = resolver.resolveFromTsNode(declaration.name);
      expect(resolved).toBe(ExternTypes.dataDictionary);
    });

    it("does NOT widen a user-defined interface that shares a lib-shortcut name", () => {
      // The file is a module (has `export`) so the user `interface Iterator`
      // is module-scoped and does NOT global-merge with lib.es2015.iterable's
      // `Iterator<T>`. The resolver-side lib gate must therefore reject the
      // shortcut (no lib declaration on this symbol) and fall through to
      // `buildInterfaceTypeSymbol`, yielding a structural InterfaceTypeSymbol
      // with the user's `next` property — not the ObjectType widening that
      // the lib `Iterator` shortcut would produce.
      const filePath = "/virtual/type_resolver_user_iterator.ts";
      const source = `
        export interface Iterator { next: number; }
        export const it: Iterator = { next: 1 };
      `;
      const { context, resolver } = createResolverFromSource(source, filePath);
      const sourceFile = context.getSourceFile(filePath);
      expect(sourceFile).toBeDefined();
      const declaration = findVariableDeclarationByName(
        sourceFile as ts.SourceFile,
        "it",
      );
      const resolved = resolver.resolveFromTsNode(declaration.name);
      expect(resolved).toBeInstanceOf(InterfaceTypeSymbol);
      const iface = resolved as InterfaceTypeSymbol;
      expect(iface.name).toBe("Iterator");
      expect(iface.properties.get("next")).toBe(PrimitiveTypes.single);
    });

    it("returns distinct InterfaceTypeSymbols for different generic instantiations of a user interface", () => {
      // Regression check: an instantiated TypeReference's own
      // `typeParameters` is undefined (the params live on `target`), so a
      // naive non-generic check would mis-detect IList<string> /
      // IList<number> as non-generic and conflate them under a single
      // symbol-keyed cache entry. Property types must remain distinct.
      const filePath = "/virtual/type_resolver_generic_iface.ts";
      const source = `
        interface IList<T> { head: T; tail: T[]; }
        const a: IList<string> = { head: "x", tail: ["y"] };
        const b: IList<number> = { head: 1, tail: [2] };
      `;
      const { context, resolver } = createResolverFromSource(source, filePath);
      const sourceFile = context.getSourceFile(filePath);
      expect(sourceFile).toBeDefined();
      const aDecl = findVariableDeclarationByName(
        sourceFile as ts.SourceFile,
        "a",
      );
      const bDecl = findVariableDeclarationByName(
        sourceFile as ts.SourceFile,
        "b",
      );
      const a = resolver.resolveFromTsNode(aDecl.name);
      const b = resolver.resolveFromTsNode(bDecl.name);
      expect(a).toBeInstanceOf(InterfaceTypeSymbol);
      expect(b).toBeInstanceOf(InterfaceTypeSymbol);
      const aHead = (a as InterfaceTypeSymbol).properties.get("head");
      const bHead = (b as InterfaceTypeSymbol).properties.get("head");
      expect(aHead).toBe(PrimitiveTypes.string);
      expect(bHead).toBe(PrimitiveTypes.single);
    });

    it("widens user-augmented lib interfaces too (some-based gate, by design)", () => {
      // Non-module script file (no `export`/`import`) so the top-level
      // `interface Map<K,V>` merges into lib.es2015.collection's global
      // Map symbol — the resulting symbol carries declarations from BOTH
      // the lib `.d.ts` and the user's file. `isLibInterfaceSymbol` uses
      // `some`, so the merged case still hits the builtin shortcut and
      // resolves to `dataDictionary`. The added `myExtension` member is
      // intentionally dropped — see the comment on `isLibInterfaceSymbol`
      // for the full trade-off, including why a stricter `every`-based
      // gate was tried and reverted (it caused a TypeScript-internal
      // stack overflow when fully populating the merged Map's members).
      const filePath = "/virtual/type_resolver_user_augmented_map.ts";
      const source = `
        interface Map<K, V> { myExtension: number; }
        declare const m: Map<string, number>;
      `;
      const { context, resolver } = createResolverFromSource(source, filePath);
      const sourceFile = context.getSourceFile(filePath);
      expect(sourceFile).toBeDefined();
      const declaration = findVariableDeclarationByName(
        sourceFile as ts.SourceFile,
        "m",
      );
      const resolved = resolver.resolveFromTsNode(declaration.name);
      expect(resolved).toBe(ExternTypes.dataDictionary);
    });

    it("returns the same InterfaceTypeSymbol for two uses of a non-generic user interface (symbol-keyed cache)", () => {
      const filePath = "/virtual/type_resolver_nongeneric_iface.ts";
      const source = `
        interface IFoo { name: string; }
        const x: IFoo = { name: "a" };
        const y: IFoo = { name: "b" };
      `;
      const { context, resolver } = createResolverFromSource(source, filePath);
      const sourceFile = context.getSourceFile(filePath);
      expect(sourceFile).toBeDefined();
      const xDecl = findVariableDeclarationByName(
        sourceFile as ts.SourceFile,
        "x",
      );
      const yDecl = findVariableDeclarationByName(
        sourceFile as ts.SourceFile,
        "y",
      );
      const x = resolver.resolveFromTsNode(xDecl.name);
      const y = resolver.resolveFromTsNode(yDecl.name);
      // Identity equality, not just structural — confirms the cache fired.
      expect(x).toBe(y);
    });

    it("astNodeCache returns the cached result on a repeat resolveFromAstNode call", () => {
      // `astNodeCache` is keyed on AST node identity, so two calls with
      // the *same* node short-circuit. (The cross-AST-node "different
      // sites, same symbol" cache hit is already covered above by
      // resolveFromTsNode — the resolveFromAstNode entry point goes
      // through the same chain so it inherits that behaviour.)
      const filePath = "/virtual/type_resolver_ast_cache_repeat.ts";
      const source = `
        class Service {
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
        (m): m is MethodDeclarationNode => m.name === "Start",
      );
      expect(method).toBeDefined();
      const initializer = (
        (method as MethodDeclarationNode).body
          .statements[0] as VariableDeclarationNode
      ).initializer;
      expect(initializer).toBeDefined();
      const resolver = createTypeCheckerTypeResolver(
        context,
        parser.typeMapper,
      );
      const first = resolver.resolveFromAstNode(
        initializer as NonNullable<typeof initializer>,
        context,
      );
      const second = resolver.resolveFromAstNode(
        initializer as NonNullable<typeof initializer>,
        context,
      );
      expect(first).toBe(PrimitiveTypes.boolean);
      // Same AST node → astNodeCache hit on the second call.
      expect(second).toBe(first);
    });
  });
});

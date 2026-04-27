/**
 * TypeScript parser for converting TS source to simplified AST
 */

import * as ts from "typescript";
import { ErrorCollector } from "../../errors/error_collector.js";
import type { TranspileErrorLocation } from "../../errors/transpile_errors.js";
import { EnumRegistry } from "../enum_registry.js";
import { SymbolTable } from "../symbol_table.js";
import type { TypeCheckerContext } from "../type_checker_context.js";
import {
  createTypeCheckerTypeResolver,
  type TypeCheckerTypeResolver,
} from "../type_checker_type_resolver.js";
import { TypeMapper } from "../type_mapper.js";
import {
  extractArrayLiteralHint,
  type InterfaceTypeSymbol,
  type TypeSymbol,
} from "../type_symbols.js";
import { type ASTNode, ASTNodeKind, type ProgramNode } from "../types.js";
import {
  createUnsupportedExpressionPlaceholder,
  reportTypeError,
  reportUnsupportedNode,
  warnEnumInitializer,
} from "./errors.js";
import {
  inferType,
  isStringTypeNode,
  mapTypeWithGenerics,
  resolveGenericParam,
  resolveStructuralUnionType,
} from "./types.js";
import {
  visitClassDeclaration,
  visitDecorator,
  visitEnumDeclaration,
  visitInterfaceDeclaration,
  visitMethodDeclaration,
  visitPropertyDeclaration,
} from "./visitors/declaration.js";
import {
  visitArrayLiteralExpression,
  visitAsExpression,
  visitBinaryExpression,
  visitCallExpression,
  visitConditionalExpression,
  visitDeleteExpression,
  visitElementAccessExpression,
  visitExpression,
  visitFunctionLiteralExpression,
  visitIdentifier,
  visitLiteral,
  visitNameofExpression,
  visitNewExpression,
  visitNonNullExpression,
  visitObjectLiteralExpression,
  visitOptionalChainingExpression,
  visitParenthesizedExpression,
  visitPropertyAccessExpression,
  visitRegexLiteralExpression,
  visitSuperExpression,
  visitTemplateExpression,
  visitThisExpression,
  visitTypeofExpression,
  visitUnaryExpression,
  visitUpdateExpression,
} from "./visitors/expression.js";
import {
  visitBlock,
  visitBreakStatement,
  visitContinueStatement,
  visitDoWhileStatement,
  visitForInStatement,
  visitForOfStatement,
  visitForStatement,
  visitIfStatement,
  visitNode,
  visitReturnStatement,
  visitSwitchStatement,
  visitThrowStatement,
  visitTryStatement,
  visitTypeAliasDeclaration,
  visitVariableStatement,
  visitWhileStatement,
} from "./visitors/statement.js";

export class TypeScriptParser {
  symbolTable: SymbolTable;
  errorCollector: ErrorCollector;
  sourceFile: ts.SourceFile | null = null;
  currentFilePath = "temp.ts";
  typeMapper: TypeMapper;
  enumRegistry: EnumRegistry;
  genericTypeParamStack: Array<Set<string>> = [];
  destructureCounter = 0;
  anonTypeCounter = 0;
  anonUnionCounter = 0;
  anonUnionCache: Map<string, InterfaceTypeSymbol> = new Map();
  private readonly importCache: Map<string, string[]> = new Map();
  checkerContext?: TypeCheckerContext;
  checkerTypeResolver?: TypeCheckerTypeResolver;

  constructor(
    errorCollector?: ErrorCollector,
    checkerContext?: TypeCheckerContext,
  ) {
    this.symbolTable = new SymbolTable();
    this.errorCollector = errorCollector ?? new ErrorCollector();
    this.enumRegistry = new EnumRegistry();
    this.typeMapper = new TypeMapper(this.enumRegistry);
    this.setCheckerContext(checkerContext);
  }

  setCheckerContext(checkerContext?: TypeCheckerContext): void {
    this.checkerContext = checkerContext;
    if (checkerContext) {
      this.checkerTypeResolver = createTypeCheckerTypeResolver(
        checkerContext,
        this.typeMapper,
      );
    } else {
      this.checkerTypeResolver = undefined;
    }
  }

  /**
   * Parse TypeScript source code into simplified AST
   */
  parse(sourceCode: string, filePath = "temp.ts"): ProgramNode {
    this.symbolTable = new SymbolTable();
    this.anonTypeCounter = 0;
    this.anonUnionCounter = 0;
    this.anonUnionCache = new Map();
    this.currentFilePath = filePath;

    const sourceFile =
      this.checkerContext?.getSourceFile(filePath) ??
      ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.ES2020, true);
    this.sourceFile = sourceFile;

    const statements: ASTNode[] = [];
    const imports: string[] = [];
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        imports.push(statement.moduleSpecifier.text);
      }
      const node = this.visitNode(statement);
      if (node) {
        statements.push(node);
      }
    }
    this.importCache.set(filePath, imports);

    const program: ProgramNode = this.attachLoc(sourceFile, {
      kind: ASTNodeKind.Program,
      statements,
    });

    this.errorCollector.throwIfErrors();

    return program;
  }

  /**
   * Get the symbol table
   */
  getSymbolTable(): SymbolTable {
    return this.symbolTable;
  }

  /**
   * Get error collector
   */
  getErrorCollector(): ErrorCollector {
    return this.errorCollector;
  }

  createLoc(tsNode: ts.Node): TranspileErrorLocation {
    const sourceFile = this.sourceFile;
    const filePath = this.currentFilePath;
    if (!sourceFile) {
      return { filePath, line: 0, column: 0 };
    }
    // Synthesized nodes (created via ts.factory.*) have pos === -1 and no real
    // source position. Fall back to a filePath-only location.
    if (tsNode.pos < 0) {
      return { filePath, line: 0, column: 0 };
    }
    const { line, character } = ts.getLineAndCharacterOfPosition(
      sourceFile,
      tsNode.getStart(sourceFile),
    );
    return {
      filePath,
      line: line + 1,
      column: character + 1,
    };
  }

  attachLoc<T extends ASTNode>(tsNode: ts.Node, node: T): T {
    if (!node.loc) {
      node.loc = this.createLoc(tsNode);
    }
    this.checkerContext?.bindAstNode(node, tsNode);
    return node;
  }

  /**
   * Get enum registry
   */
  getEnumRegistry(): EnumRegistry {
    return this.enumRegistry;
  }

  /**
   * Returns the live import cache shared with {@link DependencyResolver}.
   * Consumers may add entries but must not replace the Map instance.
   */
  getImportCache(): Map<string, string[]> {
    return this.importCache;
  }

  mapTypeWithGenerics = mapTypeWithGenerics;
  isStringTypeNode = isStringTypeNode;
  resolveGenericParam = resolveGenericParam;
  inferType = inferType;
  resolveStructuralUnionType = resolveStructuralUnionType;

  warnEnumInitializer = warnEnumInitializer;
  reportTypeError = reportTypeError;
  reportUnsupportedNode = reportUnsupportedNode;
  createUnsupportedExpressionPlaceholder =
    createUnsupportedExpressionPlaceholder;

  visitNode = visitNode;
  visitVariableStatement = visitVariableStatement;
  visitTypeAliasDeclaration = visitTypeAliasDeclaration;
  visitIfStatement = visitIfStatement;
  visitWhileStatement = visitWhileStatement;
  visitSwitchStatement = visitSwitchStatement;
  visitDoWhileStatement = visitDoWhileStatement;
  visitBreakStatement = visitBreakStatement;
  visitContinueStatement = visitContinueStatement;
  visitReturnStatement = visitReturnStatement;
  visitTryStatement = visitTryStatement;
  visitThrowStatement = visitThrowStatement;
  visitForStatement = visitForStatement;
  visitForInStatement = visitForInStatement;
  visitForOfStatement = visitForOfStatement;
  visitBlock = visitBlock;

  visitExpression = visitExpression;
  visitBinaryExpression = visitBinaryExpression;
  visitConditionalExpression = visitConditionalExpression;
  visitTemplateExpression = visitTemplateExpression;
  visitUnaryExpression = visitUnaryExpression;
  visitUpdateExpression = visitUpdateExpression;
  visitFunctionLiteralExpression = visitFunctionLiteralExpression;
  visitRegexLiteralExpression = visitRegexLiteralExpression;
  visitNonNullExpression = visitNonNullExpression;
  visitIdentifier = visitIdentifier;
  visitThisExpression = visitThisExpression;
  visitSuperExpression = visitSuperExpression;
  visitObjectLiteralExpression = visitObjectLiteralExpression;
  visitDeleteExpression = visitDeleteExpression;
  visitPropertyAccessExpression = visitPropertyAccessExpression;
  visitOptionalChainingExpression = visitOptionalChainingExpression;
  visitLiteral = visitLiteral;
  visitCallExpression = visitCallExpression;
  visitNameofExpression = visitNameofExpression;
  visitTypeofExpression = visitTypeofExpression;
  visitElementAccessExpression = visitElementAccessExpression;
  visitNewExpression = visitNewExpression;
  visitArrayLiteralExpression = visitArrayLiteralExpression;
  visitParenthesizedExpression = visitParenthesizedExpression;
  visitAsExpression = visitAsExpression;

  visitClassDeclaration = visitClassDeclaration;
  visitInterfaceDeclaration = visitInterfaceDeclaration;
  visitDecorator = visitDecorator;
  visitPropertyDeclaration = visitPropertyDeclaration;
  visitMethodDeclaration = visitMethodDeclaration;
  visitEnumDeclaration = visitEnumDeclaration;

  /**
   * Parse a parameter default initializer (`param: T = <expr>`). For array
   * literal defaults, derive the element-type `typeHint` from the parameter's
   * annotated type so that ast_to_tac's `visitArrayLiteralExpression` picks
   * the right `DataListTypeSymbol(elementType)` at bind time.
   *
   * The typeHint is resolved via `mapTypeWithGenerics` so that `Array<T>`,
   * `ReadonlyArray<T>`, `readonly T[]`, `(T | null)[]`, etc. all produce the
   * same `ArrayTypeSymbol.elementType.name` — not a raw string-mangled
   * substring that falls back to ObjectType on anything non-trivial.
   */
  parseParameterInitializer(
    initializer: ts.Expression,
    paramTypeNode: ts.TypeNode | undefined,
  ): ASTNode {
    if (ts.isArrayLiteralExpression(initializer)) {
      const typeHint = paramTypeNode
        ? this.resolveArrayElementTypeHint(paramTypeNode)
        : undefined;
      return this.visitArrayLiteralExpression(initializer, typeHint);
    }
    return this.visitExpression(initializer);
  }

  /**
   * Extract the element-type name for an array-typed parameter annotation.
   * Returns undefined if the annotation does not resolve to an array type
   * (the caller falls back to `ObjectType` in that case).
   */
  private resolveArrayElementTypeHint(
    paramTypeNode: ts.TypeNode,
  ): TypeSymbol | undefined {
    return extractArrayLiteralHint(
      this.mapTypeWithGenerics(paramTypeNode.getText(), paramTypeNode),
    );
  }
}

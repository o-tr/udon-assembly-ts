/**
 * TypeScript parser for converting TS source to simplified AST
 */

import * as ts from "typescript";
import { ErrorCollector } from "../../errors/error_collector.js";
import { EnumRegistry } from "../enum_registry.js";
import { SymbolTable } from "../symbol_table.js";
import { TypeMapper } from "../type_mapper.js";
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
  parseGenericType,
  resolveGenericParam,
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
  typeMapper: TypeMapper;
  enumRegistry: EnumRegistry;
  genericTypeParamStack: Array<Set<string>> = [];
  destructureCounter = 0;

  constructor(errorCollector?: ErrorCollector) {
    this.symbolTable = new SymbolTable();
    this.errorCollector = errorCollector ?? new ErrorCollector();
    this.enumRegistry = new EnumRegistry();
    this.typeMapper = new TypeMapper(this.enumRegistry);
  }

  /**
   * Parse TypeScript source code into simplified AST
   */
  parse(sourceCode: string, filePath = "temp.ts"): ProgramNode {
    this.symbolTable = new SymbolTable();
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      ts.ScriptTarget.ES2020,
      true,
    );
    this.sourceFile = sourceFile;

    const statements: ASTNode[] = [];
    for (const statement of sourceFile.statements) {
      const node = this.visitNode(statement);
      if (node) {
        statements.push(node);
      }
    }

    const program: ProgramNode = {
      kind: ASTNodeKind.Program,
      statements,
    };

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

  /**
   * Get enum registry
   */
  getEnumRegistry(): EnumRegistry {
    return this.enumRegistry;
  }

  mapTypeWithGenerics = mapTypeWithGenerics;
  isStringTypeNode = isStringTypeNode;
  resolveGenericParam = resolveGenericParam;
  parseGenericType = parseGenericType;
  inferType = inferType;

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
}

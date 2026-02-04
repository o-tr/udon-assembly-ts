/**
 * TypeScript parser for converting TS source to simplified AST
 */

import * as ts from "typescript";
import { ErrorCollector } from "../errors/error_collector.js";
import { TranspileError } from "../errors/transpile_errors.js";
import { type EnumKind, EnumRegistry } from "./enum_registry.js";
import { SymbolTable } from "./symbol_table.js";
import { TypeMapper } from "./type_mapper.js";
import {
  ArrayTypeSymbol,
  ClassTypeSymbol,
  CollectionTypeSymbol,
  ExternTypes,
  GenericTypeParameterSymbol,
  ObjectType,
  PrimitiveTypes,
  type TypeSymbol,
} from "./type_symbols.js";
import {
  type ArrayAccessExpressionNode,
  type ArrayLiteralElementNode,
  type ArrayLiteralExpressionNode,
  type ASTNode,
  ASTNodeKind,
  type AsExpressionNode,
  type AssignmentExpressionNode,
  type BinaryExpressionNode,
  type BlockStatementNode,
  type BreakStatementNode,
  type CallExpressionNode,
  type CaseClauseNode,
  type ClassDeclarationNode,
  type ConditionalExpressionNode,
  type ContinueStatementNode,
  type DecoratorNode,
  type DeleteExpressionNode,
  type DoWhileStatementNode,
  type EnumDeclarationNode,
  type EnumMemberNode,
  type ForOfStatementNode,
  type ForStatementNode,
  type IdentifierNode,
  type IfStatementNode,
  type InterfaceDeclarationNode,
  type LiteralNode,
  type MethodDeclarationNode,
  type NameofExpressionNode,
  type NullCoalescingExpressionNode,
  type ObjectLiteralExpressionNode,
  type ObjectLiteralPropertyNode,
  type OptionalChainingExpressionNode,
  type ProgramNode,
  type PropertyAccessExpressionNode,
  type PropertyDeclarationNode,
  type ReturnStatementNode,
  type SuperExpressionNode,
  type SwitchStatementNode,
  type TemplateExpressionNode,
  type ThisExpressionNode,
  type ThrowStatementNode,
  type TryCatchStatementNode,
  type TypeofExpressionNode,
  UdonType,
  type UnaryExpressionNode,
  type UpdateExpressionNode,
  type VariableDeclarationNode,
  type WhileStatementNode,
} from "./types.js";
export class TypeScriptParser {
  private symbolTable: SymbolTable;
  private errorCollector: ErrorCollector;
  private sourceFile: ts.SourceFile | null = null;
  private typeMapper: TypeMapper;
  private enumRegistry: EnumRegistry;
  private genericTypeParamStack: Array<Set<string>> = [];
  private destructureCounter = 0;

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

  private mapTypeWithGenerics(typeText: string, node?: ts.Node): TypeSymbol {
    const trimmed = typeText.trim();
    const genericParam = this.resolveGenericParam(trimmed);
    if (genericParam) return genericParam;

    if (node && ts.isTypePredicateNode(node)) {
      return PrimitiveTypes.boolean;
    }

    if (
      node &&
      (ts.isTypeQueryNode(node) ||
        ts.isIndexedAccessTypeNode(node) ||
        ts.isConditionalTypeNode(node) ||
        ts.isMappedTypeNode(node) ||
        ts.isIntersectionTypeNode(node))
    ) {
      return ObjectType;
    }

    if (node && ts.isTupleTypeNode(node)) {
      return new ArrayTypeSymbol(ObjectType);
    }

    if (node && ts.isTypeLiteralNode(node)) {
      return ExternTypes.dataDictionary;
    }

    if (node && ts.isUnionTypeNode(node)) {
      if (node.types.every((t) => this.isStringTypeNode(t))) {
        return PrimitiveTypes.string;
      }
    }

    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      return ExternTypes.dataDictionary;
    }

    if (trimmed.endsWith("[]")) {
      let base = trimmed;
      let dimensions = 0;
      while (base.endsWith("[]")) {
        base = base.slice(0, -2).trim();
        dimensions += 1;
      }
      const elementType: TypeSymbol = this.mapTypeWithGenerics(base);
      return new ArrayTypeSymbol(elementType, dimensions);
    }

    const genericMatch = this.parseGenericType(trimmed);
    if (genericMatch) {
      const { base, args } = genericMatch;
      switch (base) {
        case "Array":
        case "ReadonlyArray":
          return new ArrayTypeSymbol(
            this.mapTypeWithGenerics(args[0] ?? "object"),
          );
        case "UdonList":
        case "List":
          return new CollectionTypeSymbol(
            base,
            this.mapTypeWithGenerics(args[0] ?? "object"),
          );
        case "UdonQueue":
        case "Queue":
          return new CollectionTypeSymbol(
            base,
            this.mapTypeWithGenerics(args[0] ?? "object"),
          );
        case "UdonStack":
        case "Stack":
          return new CollectionTypeSymbol(
            base,
            this.mapTypeWithGenerics(args[0] ?? "object"),
          );
        case "UdonHashSet":
        case "HashSet":
          return new CollectionTypeSymbol(
            base,
            this.mapTypeWithGenerics(args[0] ?? "object"),
          );
        case "UdonDictionary":
        case "Dictionary":
          return new CollectionTypeSymbol(
            base,
            undefined,
            this.mapTypeWithGenerics(args[0] ?? "object"),
            this.mapTypeWithGenerics(args[1] ?? "object"),
          );
        case "Record":
        case "Map":
          return ExternTypes.dataDictionary;
      }
    }

    return this.typeMapper.mapTypeScriptType(trimmed);
  }

  private isStringTypeNode(node: ts.TypeNode): boolean {
    if (node.kind === ts.SyntaxKind.StringKeyword) return true;
    if (ts.isLiteralTypeNode(node)) {
      return ts.isStringLiteral(node.literal);
    }
    if (ts.isUnionTypeNode(node)) {
      return node.types.every((t) => this.isStringTypeNode(t));
    }
    return false;
  }

  private resolveGenericParam(typeText: string): TypeSymbol | undefined {
    for (let i = this.genericTypeParamStack.length - 1; i >= 0; i -= 1) {
      const scope = this.genericTypeParamStack[i];
      if (scope?.has(typeText)) {
        return new GenericTypeParameterSymbol(typeText);
      }
    }
    return undefined;
  }

  private parseGenericType(
    tsType: string,
  ): { base: string; args: string[] } | null {
    const ltIndex = tsType.indexOf("<");
    if (ltIndex === -1 || !tsType.endsWith(">")) return null;
    const base = tsType.slice(0, ltIndex).trim();
    const argsRaw = tsType.slice(ltIndex + 1, -1).trim();
    if (!argsRaw) return { base, args: [] };
    const args: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of argsRaw) {
      if (char === "<") depth += 1;
      if (char === ">") depth -= 1;
      if (char === "," && depth === 0) {
        args.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    if (current.trim().length > 0) {
      args.push(current.trim());
    }
    return { base, args };
  }

  /**
   * Visit a TypeScript AST node and convert to simplified AST
   */
  private visitNode(node: ts.Node): ASTNode | undefined {
    switch (node.kind) {
      case ts.SyntaxKind.ImportDeclaration:
        return undefined;
      case ts.SyntaxKind.ExportDeclaration:
        return undefined;
      case ts.SyntaxKind.VariableStatement:
        return this.visitVariableStatement(node as ts.VariableStatement);
      case ts.SyntaxKind.TypeAliasDeclaration:
        return this.visitTypeAliasDeclaration(node as ts.TypeAliasDeclaration);
      case ts.SyntaxKind.FunctionDeclaration:
        return undefined;
      case ts.SyntaxKind.IfStatement:
        return this.visitIfStatement(node as ts.IfStatement);
      case ts.SyntaxKind.WhileStatement:
        return this.visitWhileStatement(node as ts.WhileStatement);
      case ts.SyntaxKind.ForStatement:
        return this.visitForStatement(node as ts.ForStatement);
      case ts.SyntaxKind.ForOfStatement:
        return this.visitForOfStatement(node as ts.ForOfStatement);
      case ts.SyntaxKind.SwitchStatement:
        return this.visitSwitchStatement(node as ts.SwitchStatement);
      case ts.SyntaxKind.DoStatement:
        return this.visitDoWhileStatement(node as ts.DoStatement);
      case ts.SyntaxKind.BreakStatement:
        return this.visitBreakStatement();
      case ts.SyntaxKind.ContinueStatement:
        return this.visitContinueStatement();
      case ts.SyntaxKind.TryStatement:
        return this.visitTryStatement(node as ts.TryStatement);
      case ts.SyntaxKind.ThrowStatement:
        return this.visitThrowStatement(node as ts.ThrowStatement);
      case ts.SyntaxKind.Block:
        return this.visitBlock(node as ts.Block);
      case ts.SyntaxKind.ExpressionStatement:
        return this.visitExpression(
          (node as ts.ExpressionStatement).expression,
        );
      case ts.SyntaxKind.ReturnStatement:
        return this.visitReturnStatement(node as ts.ReturnStatement);
      case ts.SyntaxKind.ClassDeclaration:
        return this.visitClassDeclaration(node as ts.ClassDeclaration);
      case ts.SyntaxKind.EnumDeclaration:
        return this.visitEnumDeclaration(node as ts.EnumDeclaration);
      case ts.SyntaxKind.InterfaceDeclaration:
        return this.visitInterfaceDeclaration(node as ts.InterfaceDeclaration);
      default:
        this.reportUnsupportedNode(
          node,
          `Unsupported statement: ${ts.SyntaxKind[node.kind]}`,
          "Refactor to the supported subset or remove this construct.",
        );
        return undefined;
    }
  }

  /**
   * Visit variable declaration
   */
  private visitVariableStatement(
    node: ts.VariableStatement,
  ): ASTNode | undefined {
    const declaration = node.declarationList.declarations[0];
    if (!declaration) return undefined;
    const isConst = !!(node.declarationList.flags & ts.NodeFlags.Const);

    if (ts.isArrayBindingPattern(declaration.name)) {
      if (!declaration.initializer) {
        this.reportUnsupportedNode(
          declaration,
          "Array destructuring without initializer is not supported",
          "Provide an initializer for the destructured array.",
        );
        return undefined;
      }

      const tempName = `__destructure_${this.destructureCounter++}`;
      const initExpr = declaration.initializer;
      const tempType = this.inferType(initExpr);
      this.symbolTable.addSymbol(tempName, tempType, false, true);

      const tempDecl: VariableDeclarationNode = {
        kind: ASTNodeKind.VariableDeclaration,
        name: tempName,
        type: tempType,
        isConst: true,
        initializer: this.visitExpression(initExpr),
      };

      const elementType =
        tempType instanceof ArrayTypeSymbol ? tempType.elementType : ObjectType;

      const statements: ASTNode[] = [tempDecl];
      for (let i = 0; i < declaration.name.elements.length; i += 1) {
        const element = declaration.name.elements[i];
        if (!ts.isBindingElement(element)) continue;
        const varName = element.name.getText();
        if (!this.symbolTable.hasInCurrentScope(varName)) {
          this.symbolTable.addSymbol(varName, elementType, false, isConst);
        }
        const arrayAccess: ArrayAccessExpressionNode = {
          kind: ASTNodeKind.ArrayAccessExpression,
          array: {
            kind: ASTNodeKind.Identifier,
            name: tempName,
          } as IdentifierNode,
          index: {
            kind: ASTNodeKind.Literal,
            value: i,
            type: PrimitiveTypes.int32,
          } as LiteralNode,
        };
        statements.push({
          kind: ASTNodeKind.VariableDeclaration,
          name: varName,
          type: elementType,
          isConst,
          initializer: arrayAccess,
        } as VariableDeclarationNode);
      }

      return {
        kind: ASTNodeKind.BlockStatement,
        statements,
      } as BlockStatementNode;
    }

    if (ts.isObjectBindingPattern(declaration.name)) {
      if (!declaration.initializer) {
        this.reportUnsupportedNode(
          declaration,
          "Object destructuring without initializer is not supported",
          "Provide an initializer for the destructured object.",
        );
        return undefined;
      }

      const tempName = `__destructure_${this.destructureCounter++}`;
      const initExpr = declaration.initializer;
      const tempType = this.inferType(initExpr);
      this.symbolTable.addSymbol(tempName, tempType, false, true);

      const tempDecl: VariableDeclarationNode = {
        kind: ASTNodeKind.VariableDeclaration,
        name: tempName,
        type: tempType,
        isConst: true,
        initializer: this.visitExpression(initExpr),
      };

      const statements: ASTNode[] = [tempDecl];
      for (const element of declaration.name.elements) {
        if (!ts.isBindingElement(element)) continue;
        const varName = element.name.getText();
        const propName = element.propertyName
          ? element.propertyName.getText()
          : varName;
        if (!this.symbolTable.hasInCurrentScope(varName)) {
          this.symbolTable.addSymbol(varName, ObjectType, false, isConst);
        }
        const propertyAccess: PropertyAccessExpressionNode = {
          kind: ASTNodeKind.PropertyAccessExpression,
          object: {
            kind: ASTNodeKind.Identifier,
            name: tempName,
          } as IdentifierNode,
          property: propName,
        };
        statements.push({
          kind: ASTNodeKind.VariableDeclaration,
          name: varName,
          type: ObjectType,
          isConst,
          initializer: propertyAccess,
        } as VariableDeclarationNode);
      }

      return {
        kind: ASTNodeKind.BlockStatement,
        statements,
      } as BlockStatementNode;
    }

    const name = declaration.name.getText();

    // Infer type from initializer or type annotation
    let type: TypeSymbol = this.mapTypeWithGenerics("number");
    if (declaration.type) {
      const typeText = declaration.type.getText();
      type = this.mapTypeWithGenerics(typeText, declaration.type);
    } else if (declaration.initializer) {
      type = this.inferType(declaration.initializer);
    }

    // Add to symbol table
    this.symbolTable.addSymbol(name, type, false, isConst);

    const result: VariableDeclarationNode = {
      kind: ASTNodeKind.VariableDeclaration,
      name,
      type,
      isConst,
    };

    if (declaration.initializer) {
      if (ts.isArrayLiteralExpression(declaration.initializer)) {
        const typeHint = declaration.type
          ? declaration.type.getText().replace(/\[\]$/, "")
          : undefined;
        result.initializer = this.visitArrayLiteralExpression(
          declaration.initializer,
          typeHint,
        );
      } else {
        result.initializer = this.visitExpression(declaration.initializer);
      }
    }

    return result;
  }

  /**
   * Visit type alias declaration
   */
  private visitTypeAliasDeclaration(
    node: ts.TypeAliasDeclaration,
  ): InterfaceDeclarationNode | undefined {
    const name = node.name.getText();
    const mapped = this.mapTypeWithGenerics(node.type.getText(), node.type);
    this.typeMapper.registerTypeAlias(name, mapped);
    if (!ts.isTypeLiteralNode(node.type)) {
      return undefined;
    }

    const properties: InterfaceDeclarationNode["properties"] = [];
    const methods: InterfaceDeclarationNode["methods"] = [];

    for (const member of node.type.members) {
      if (ts.isPropertySignature(member)) {
        const propName = member.name.getText();
        const propType = member.type
          ? this.mapTypeWithGenerics(member.type.getText(), member.type)
          : this.mapTypeWithGenerics("object");
        properties.push({ name: propName, type: propType });
      } else if (ts.isMethodSignature(member)) {
        const methodName = member.name.getText();
        const parameters = member.parameters.map((param) => ({
          name: param.name.getText(),
          type: param.type
            ? this.mapTypeWithGenerics(param.type.getText(), param.type)
            : this.mapTypeWithGenerics("object"),
        }));
        const returnType = member.type
          ? this.mapTypeWithGenerics(member.type.getText(), member.type)
          : this.mapTypeWithGenerics("void");
        methods.push({ name: methodName, parameters, returnType });
      }
    }

    return {
      kind: ASTNodeKind.InterfaceDeclaration,
      name,
      properties,
      methods,
    };
  }

  /**
   * Visit if statement
   */
  private visitIfStatement(node: ts.IfStatement): IfStatementNode {
    const thenBranch = this.visitNode(node.thenStatement);
    if (!thenBranch) {
      throw new Error("If statement must have a then branch");
    }

    return {
      kind: ASTNodeKind.IfStatement,
      condition: this.visitExpression(node.expression),
      thenBranch,
      elseBranch: node.elseStatement
        ? this.visitNode(node.elseStatement)
        : undefined,
    };
  }

  /**
   * Visit while statement
   */
  private visitWhileStatement(node: ts.WhileStatement): WhileStatementNode {
    const body = this.visitNode(node.statement);
    if (!body) {
      throw new Error("While statement must have a body");
    }

    return {
      kind: ASTNodeKind.WhileStatement,
      condition: this.visitExpression(node.expression),
      body,
    };
  }

  private visitSwitchStatement(node: ts.SwitchStatement): SwitchStatementNode {
    const expression = this.visitExpression(node.expression);
    const cases: CaseClauseNode[] = node.caseBlock.clauses.map((clause) => {
      if (ts.isCaseClause(clause)) {
        return {
          kind: ASTNodeKind.CaseClause,
          expression: this.visitExpression(clause.expression),
          statements: clause.statements
            .map((stmt) => this.visitNode(stmt))
            .filter((stmt): stmt is ASTNode => !!stmt),
        };
      }
      return {
        kind: ASTNodeKind.CaseClause,
        expression: null,
        statements: clause.statements
          .map((stmt) => this.visitNode(stmt))
          .filter((stmt): stmt is ASTNode => !!stmt),
      };
    });

    return {
      kind: ASTNodeKind.SwitchStatement,
      expression,
      cases,
    };
  }

  private visitDoWhileStatement(node: ts.DoStatement): DoWhileStatementNode {
    const body = this.visitNode(node.statement);
    if (!body) {
      throw new Error("Do-while statement must have a body");
    }

    return {
      kind: ASTNodeKind.DoWhileStatement,
      body,
      condition: this.visitExpression(node.expression),
    };
  }

  private visitBreakStatement(): BreakStatementNode {
    return {
      kind: ASTNodeKind.BreakStatement,
    };
  }

  private visitContinueStatement(): ContinueStatementNode {
    return {
      kind: ASTNodeKind.ContinueStatement,
    };
  }

  private visitReturnStatement(node: ts.ReturnStatement): ReturnStatementNode {
    return {
      kind: ASTNodeKind.ReturnStatement,
      value: node.expression
        ? this.visitExpression(node.expression)
        : undefined,
    };
  }

  private visitTryStatement(node: ts.TryStatement): TryCatchStatementNode {
    const tryBody = this.visitBlock(node.tryBlock);
    const catchClause = node.catchClause;
    const catchVariable = catchClause?.variableDeclaration
      ? catchClause.variableDeclaration.name.getText()
      : undefined;
    const catchBody = catchClause?.block
      ? this.visitBlock(catchClause.block)
      : undefined;
    const finallyBody = node.finallyBlock
      ? this.visitBlock(node.finallyBlock)
      : undefined;

    return {
      kind: ASTNodeKind.TryCatchStatement,
      tryBody,
      catchVariable,
      catchBody,
      finallyBody,
    };
  }

  private visitThrowStatement(node: ts.ThrowStatement): ThrowStatementNode {
    return {
      kind: ASTNodeKind.ThrowStatement,
      expression: this.visitExpression(node.expression),
    };
  }

  /**
   * Visit for statement
   */
  private visitForStatement(node: ts.ForStatement): ForStatementNode {
    this.symbolTable.enterScope();

    const initializer = node.initializer
      ? ts.isVariableDeclarationList(node.initializer)
        ? this.visitVariableStatement(
            ts.factory.createVariableStatement(undefined, node.initializer),
          )
        : this.visitExpression(node.initializer as ts.Expression)
      : undefined;

    const condition = node.condition
      ? this.visitExpression(node.condition)
      : undefined;
    const incrementor = node.incrementor
      ? this.visitExpression(node.incrementor)
      : undefined;

    const body = this.visitNode(node.statement);
    if (!body) {
      this.symbolTable.exitScope();
      throw new Error("For statement must have a body");
    }

    const result: ForStatementNode = {
      kind: ASTNodeKind.ForStatement,
      initializer: initializer ?? undefined,
      condition,
      incrementor,
      body,
    };

    this.symbolTable.exitScope();
    return result;
  }

  /**
   * Visit for-of statement
   */
  private visitForOfStatement(node: ts.ForOfStatement): ForOfStatementNode {
    const decl = node.initializer as ts.VariableDeclarationList;
    const varDecl = decl.declarations[0];
    const iterable = this.visitExpression(node.expression);
    this.symbolTable.enterScope();

    let varName: string | string[] = varDecl.name.getText();
    let destructureProperties:
      | Array<{ name: string; property: string }>
      | undefined;
    if (ts.isArrayBindingPattern(varDecl.name)) {
      varName = varDecl.name.elements
        .map((element) =>
          ts.isBindingElement(element) ? element.name.getText() : "",
        )
        .filter((name) => name.length > 0);
      for (const name of varName) {
        if (!this.symbolTable.hasInCurrentScope(name)) {
          this.symbolTable.addSymbol(
            name,
            this.mapTypeWithGenerics("object"),
            false,
            false,
          );
        }
      }
    } else if (ts.isObjectBindingPattern(varDecl.name)) {
      const tempName = `__forof_destructure_${this.destructureCounter++}`;
      varName = tempName;
      if (!this.symbolTable.hasInCurrentScope(tempName)) {
        this.symbolTable.addSymbol(
          tempName,
          this.mapTypeWithGenerics("object"),
          false,
          false,
        );
      }
      destructureProperties = [];
      for (const element of varDecl.name.elements) {
        if (!ts.isBindingElement(element)) continue;
        const name = element.name.getText();
        const property = element.propertyName
          ? element.propertyName.getText()
          : name;
        destructureProperties.push({ name, property });
        if (!this.symbolTable.hasInCurrentScope(name)) {
          this.symbolTable.addSymbol(
            name,
            this.mapTypeWithGenerics("object"),
            false,
            false,
          );
        }
      }
    } else {
      const varType = varDecl.type
        ? this.mapTypeWithGenerics(varDecl.type.getText(), varDecl.type)
        : this.mapTypeWithGenerics("object");
      if (!this.symbolTable.hasInCurrentScope(varName)) {
        this.symbolTable.addSymbol(varName, varType, false, false);
      }
    }

    const body = this.visitNode(node.statement);
    if (!body) {
      this.symbolTable.exitScope();
      throw new Error("For-of statement must have a body");
    }

    const result: ForOfStatementNode = {
      kind: ASTNodeKind.ForOfStatement,
      variable: varName,
      variableType: varDecl.type ? varDecl.type.getText() : undefined,
      destructureProperties,
      iterable,
      body,
    };

    this.symbolTable.exitScope();
    return result;
  }

  /**
   * Visit block statement
   */
  private visitBlock(node: ts.Block): BlockStatementNode {
    this.symbolTable.enterScope();

    const statements: ASTNode[] = [];
    for (const statement of node.statements) {
      const visitedNode = this.visitNode(statement);
      if (visitedNode) {
        statements.push(visitedNode);
      }
    }

    this.symbolTable.exitScope();

    return {
      kind: ASTNodeKind.BlockStatement,
      statements,
    };
  }

  /**
   * Visit expression
   */
  private visitExpression(node: ts.Expression): ASTNode {
    switch (node.kind) {
      case ts.SyntaxKind.BinaryExpression:
        return this.visitBinaryExpression(node as ts.BinaryExpression);
      case ts.SyntaxKind.ConditionalExpression:
        return this.visitConditionalExpression(
          node as ts.ConditionalExpression,
        );
      case ts.SyntaxKind.PrefixUnaryExpression:
        if (
          (node as ts.PrefixUnaryExpression).operator ===
            ts.SyntaxKind.PlusPlusToken ||
          (node as ts.PrefixUnaryExpression).operator ===
            ts.SyntaxKind.MinusMinusToken
        ) {
          return this.visitUpdateExpression(node as ts.PrefixUnaryExpression);
        }
        return this.visitUnaryExpression(node as ts.PrefixUnaryExpression);
      case ts.SyntaxKind.PostfixUnaryExpression:
        return this.visitUpdateExpression(node as ts.PostfixUnaryExpression);
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.TypeAssertionExpression:
        return this.visitAsExpression(node as ts.AsExpression);
      case ts.SyntaxKind.Identifier:
        return this.visitIdentifier(node as ts.Identifier);
      case ts.SyntaxKind.NumericLiteral:
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.BigIntLiteral:
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
      case ts.SyntaxKind.NullKeyword:
        return this.visitLiteral(node);
      case ts.SyntaxKind.RegularExpressionLiteral:
        return this.visitRegexLiteralExpression(
          node as ts.RegularExpressionLiteral,
        );
      case ts.SyntaxKind.NonNullExpression:
        return this.visitNonNullExpression(node as ts.NonNullExpression);
      case ts.SyntaxKind.DeleteExpression:
        return this.visitDeleteExpression(node as ts.DeleteExpression);
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        return this.visitTemplateExpression(
          node as ts.NoSubstitutionTemplateLiteral,
        );
      case ts.SyntaxKind.TemplateExpression:
        return this.visitTemplateExpression(node as ts.TemplateExpression);
      case ts.SyntaxKind.CallExpression:
        return this.visitCallExpression(node as ts.CallExpression);
      case ts.SyntaxKind.TypeOfExpression:
        return this.visitTypeofExpression(node as ts.TypeOfExpression);
      case ts.SyntaxKind.ElementAccessExpression:
        return this.visitElementAccessExpression(
          node as ts.ElementAccessExpression,
        );
      case ts.SyntaxKind.NewExpression:
        return this.visitNewExpression(node as ts.NewExpression);
      case ts.SyntaxKind.PropertyAccessExpression:
        if (ts.isPropertyAccessChain(node)) {
          return this.visitOptionalChainingExpression(
            node as ts.PropertyAccessChain,
          );
        }
        return this.visitPropertyAccessExpression(
          node as ts.PropertyAccessExpression,
        );
      case ts.SyntaxKind.ParenthesizedExpression:
        return this.visitParenthesizedExpression(
          node as ts.ParenthesizedExpression,
        );
      case ts.SyntaxKind.ArrayLiteralExpression:
        return this.visitArrayLiteralExpression(
          node as ts.ArrayLiteralExpression,
          undefined,
        );
      case ts.SyntaxKind.ObjectLiteralExpression:
        return this.visitObjectLiteralExpression(
          node as ts.ObjectLiteralExpression,
        );
      case ts.SyntaxKind.ThisKeyword:
        return this.visitThisExpression();
      case ts.SyntaxKind.SuperKeyword:
        return this.visitSuperExpression();
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.FunctionExpression:
        return this.visitFunctionLiteralExpression();
      default:
        this.reportUnsupportedNode(
          node,
          `Unsupported expression: ${ts.SyntaxKind[node.kind]}`,
          "Refactor to the supported subset or remove this expression.",
        );
        return this.createUnsupportedExpressionPlaceholder();
    }
  }

  /**
   * Visit binary expression
   */
  private visitBinaryExpression(
    node: ts.BinaryExpression,
  ):
    | BinaryExpressionNode
    | AssignmentExpressionNode
    | NullCoalescingExpressionNode {
    const operator = node.operatorToken.getText();

    // Handle assignment separately
    if (operator === "=") {
      return {
        kind: ASTNodeKind.AssignmentExpression,
        target: this.visitExpression(node.left),
        value: this.visitExpression(node.right),
      };
    }

    if (operator === "??") {
      const coalesceNode: NullCoalescingExpressionNode = {
        kind: ASTNodeKind.NullCoalescingExpression,
        left: this.visitExpression(node.left),
        right: this.visitExpression(node.right),
      };
      return coalesceNode;
    }

    return {
      kind: ASTNodeKind.BinaryExpression,
      operator,
      left: this.visitExpression(node.left),
      right: this.visitExpression(node.right),
    };
  }

  private visitConditionalExpression(
    node: ts.ConditionalExpression,
  ): ConditionalExpressionNode {
    return {
      kind: ASTNodeKind.ConditionalExpression,
      condition: this.visitExpression(node.condition),
      whenTrue: this.visitExpression(node.whenTrue),
      whenFalse: this.visitExpression(node.whenFalse),
    };
  }

  private visitTemplateExpression(
    node: ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral,
  ): TemplateExpressionNode {
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      return {
        kind: ASTNodeKind.TemplateExpression,
        parts: [{ kind: "text", value: node.text }],
      };
    }

    const parts: TemplateExpressionNode["parts"] = [];
    if (node.head.text.length > 0) {
      parts.push({ kind: "text", value: node.head.text });
    }
    for (const span of node.templateSpans) {
      parts.push({
        kind: "expression",
        expression: this.visitExpression(span.expression),
      });
      if (span.literal.text.length > 0) {
        parts.push({ kind: "text", value: span.literal.text });
      }
    }

    return {
      kind: ASTNodeKind.TemplateExpression,
      parts,
    };
  }

  /**
   * Visit unary expression
   */
  private visitUnaryExpression(
    node: ts.PrefixUnaryExpression,
  ): UnaryExpressionNode {
    return {
      kind: ASTNodeKind.UnaryExpression,
      operator: node.operator === ts.SyntaxKind.ExclamationToken ? "!" : "-",
      operand: this.visitExpression(node.operand),
    };
  }

  private visitUpdateExpression(
    node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
  ): UpdateExpressionNode {
    const operator = node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
    const operand = this.visitExpression(node.operand);
    return {
      kind: ASTNodeKind.UpdateExpression,
      operator,
      operand,
      isPostfix: ts.isPostfixUnaryExpression(node),
    };
  }

  private visitFunctionLiteralExpression(): LiteralNode {
    return {
      kind: ASTNodeKind.Literal,
      value: 0,
      type: this.typeMapper.mapTypeScriptType("object"),
    };
  }

  private visitRegexLiteralExpression(
    _node: ts.RegularExpressionLiteral,
  ): LiteralNode {
    return {
      kind: ASTNodeKind.Literal,
      value: 0,
      type: this.typeMapper.mapTypeScriptType("object"),
    };
  }

  private visitNonNullExpression(node: ts.NonNullExpression): ASTNode {
    return this.visitExpression(node.expression);
  }

  /**
   * Visit identifier
   */
  private visitIdentifier(node: ts.Identifier): IdentifierNode {
    return {
      kind: ASTNodeKind.Identifier,
      name: node.text,
    };
  }

  /**
   * Visit this expression
   */
  private visitThisExpression(): ThisExpressionNode {
    return {
      kind: ASTNodeKind.ThisExpression,
    };
  }

  /**
   * Visit super expression
   */
  private visitSuperExpression(): SuperExpressionNode {
    return {
      kind: ASTNodeKind.SuperExpression,
    };
  }

  /**
   * Visit object literal expression
   */
  private visitObjectLiteralExpression(
    node: ts.ObjectLiteralExpression,
  ): ObjectLiteralExpressionNode {
    const properties: ObjectLiteralPropertyNode[] = [];

    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        properties.push({
          kind: "spread",
          value: this.visitExpression(prop.expression),
        });
        continue;
      }

      if (ts.isPropertyAssignment(prop)) {
        if (ts.isComputedPropertyName(prop.name)) {
          this.reportUnsupportedNode(
            prop,
            "Computed property names in object literals are not supported",
            "Use a string literal or identifier key.",
          );
          continue;
        }

        let key = prop.name.getText();
        if (ts.isStringLiteral(prop.name)) {
          key = prop.name.text;
        } else if (ts.isNumericLiteral(prop.name)) {
          key = prop.name.text;
        }

        properties.push({
          kind: "property",
          key,
          value: this.visitExpression(prop.initializer),
        });
        continue;
      }

      if (ts.isShorthandPropertyAssignment(prop)) {
        const key = prop.name.getText();
        properties.push({
          kind: "property",
          key,
          value: this.visitIdentifier(prop.name),
        });
        continue;
      }

      if (
        ts.isGetAccessorDeclaration(prop) ||
        ts.isSetAccessorDeclaration(prop) ||
        ts.isMethodDeclaration(prop)
      ) {
        continue;
      }

      this.reportUnsupportedNode(
        prop,
        `Unsupported object literal member: ${ts.SyntaxKind[(prop as ts.Node).kind]}`,
        "Use property assignments or spread only.",
      );
    }

    return {
      kind: ASTNodeKind.ObjectLiteralExpression,
      properties,
    };
  }

  /**
   * Visit delete expression
   */
  private visitDeleteExpression(
    node: ts.DeleteExpression,
  ): DeleteExpressionNode {
    return {
      kind: ASTNodeKind.DeleteExpression,
      target: this.visitExpression(node.expression),
    };
  }

  /**
   * Visit property access expression
   */
  private visitPropertyAccessExpression(
    node: ts.PropertyAccessExpression,
  ): PropertyAccessExpressionNode {
    return {
      kind: ASTNodeKind.PropertyAccessExpression,
      object: this.visitExpression(node.expression),
      property: node.name.getText(),
    };
  }

  private visitOptionalChainingExpression(
    node: ts.PropertyAccessChain,
  ): OptionalChainingExpressionNode {
    return {
      kind: ASTNodeKind.OptionalChainingExpression,
      object: this.visitExpression(node.expression),
      property: node.name.getText(),
    };
  }

  /**
   * Visit literal
   */
  private visitLiteral(node: ts.Expression): LiteralNode {
    let value: number | string | boolean | bigint | null;
    let type: TypeSymbol;

    switch (node.kind) {
      case ts.SyntaxKind.NumericLiteral:
        value = Number((node as ts.NumericLiteral).text);
        type = this.typeMapper.inferLiteralType(value);
        break;
      case ts.SyntaxKind.StringLiteral:
        value = (node as ts.StringLiteral).text;
        type = this.typeMapper.inferLiteralType(value);
        break;
      case ts.SyntaxKind.BigIntLiteral: {
        const raw = (node as ts.BigIntLiteral).text;
        const normalized = raw.endsWith("n") ? raw.slice(0, -1) : raw;
        value = BigInt(normalized);
        type = this.typeMapper.inferLiteralType(value);
        break;
      }
      case ts.SyntaxKind.TrueKeyword:
        value = true;
        type = this.typeMapper.inferLiteralType(value);
        break;
      case ts.SyntaxKind.FalseKeyword:
        value = false;
        type = this.typeMapper.inferLiteralType(value);
        break;
      case ts.SyntaxKind.NullKeyword:
        value = null;
        type = this.typeMapper.mapTypeScriptType("object");
        break;
      default:
        throw new Error(
          `Unsupported literal kind: ${ts.SyntaxKind[node.kind]}`,
        );
    }

    return {
      kind: ASTNodeKind.Literal,
      value,
      type,
    };
  }

  /**
   * Visit call expression
   */
  private visitCallExpression(
    node: ts.CallExpression,
  ): CallExpressionNode | NameofExpressionNode {
    if (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "nameof" &&
      node.arguments.length === 1
    ) {
      return this.visitNameofExpression(node);
    }
    const callee = this.visitExpression(node.expression);
    const args = node.arguments.map((arg) => this.visitExpression(arg));

    return {
      kind: ASTNodeKind.CallExpression,
      callee,
      arguments: args,
      typeArguments: node.typeArguments?.map((arg) => arg.getText()),
    };
  }

  private visitNameofExpression(node: ts.CallExpression): NameofExpressionNode {
    const arg = node.arguments[0];
    const name = ts.isIdentifier(arg) ? arg.text : arg.getText();
    return {
      kind: ASTNodeKind.NameofExpression,
      name,
    };
  }

  private visitTypeofExpression(
    node: ts.TypeOfExpression,
  ): TypeofExpressionNode {
    const expr = node.expression;
    let typeName = "object";
    if (ts.isIdentifier(expr)) {
      const symbol = this.symbolTable.lookup(expr.text);
      if (symbol) {
        typeName = symbol.type.name;
      }
    }
    return {
      kind: ASTNodeKind.TypeofExpression,
      typeName,
    };
  }

  private visitElementAccessExpression(node: ts.ElementAccessExpression) {
    const arrayExpr = this.visitExpression(node.expression);
    const indexExpr = this.visitExpression(
      node.argumentExpression as ts.Expression,
    );
    return {
      kind: ASTNodeKind.ArrayAccessExpression,
      array: arrayExpr,
      index: indexExpr,
    };
  }

  private visitNewExpression(node: ts.NewExpression): CallExpressionNode {
    // Treat `new X(args)` as a call expression for now
    const callee = this.visitExpression(node.expression as ts.Expression);
    const args = (node.arguments ?? []).map((arg) => this.visitExpression(arg));
    return {
      kind: ASTNodeKind.CallExpression,
      callee,
      arguments: args,
      typeArguments: node.typeArguments?.map((arg) => arg.getText()),
      isNew: true,
    };
  }

  private visitArrayLiteralExpression(
    node: ts.ArrayLiteralExpression,
    typeHint?: string,
  ): ArrayLiteralExpressionNode {
    const elements: ArrayLiteralElementNode[] = [];

    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        // TODO: propagate the spreaded values so arrays behave like JavaScript
        elements.push({
          kind: "spread",
          value: this.visitExpression(element.expression),
        });
        continue;
      }
      elements.push({
        kind: "element",
        value: this.visitExpression(element),
      });
    }

    return {
      kind: ASTNodeKind.ArrayLiteralExpression,
      elements,
      typeHint,
    };
  }

  private visitParenthesizedExpression(
    node: ts.ParenthesizedExpression,
  ): ASTNode {
    return this.visitExpression(node.expression);
  }

  /**
   * Visit class declaration
   */
  private visitClassDeclaration(
    node: ts.ClassDeclaration,
  ): ClassDeclarationNode | undefined {
    if (!node.name) {
      this.reportUnsupportedNode(
        node,
        "Anonymous classes are not supported",
        "Give the class a name.",
      );
      return undefined;
    }

    const className = node.name.text;
    this.typeMapper.registerTypeAlias(
      className,
      new ClassTypeSymbol(className, UdonType.Object),
    );

    const rawDecorators = ts.canHaveDecorators(node)
      ? (ts.getDecorators(node) ?? [])
      : [];
    const decorators = rawDecorators.map((decorator) =>
      this.visitDecorator(decorator),
    );

    let baseClass: string | null = null;
    let implementsList: string[] | undefined;
    if (node.heritageClauses) {
      const extendsClause = node.heritageClauses.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      );
      if (extendsClause && extendsClause.types.length > 0) {
        baseClass = extendsClause.types[0]?.expression.getText() ?? null;
      }
      const implementsClause = node.heritageClauses.find(
        (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword,
      );
      if (implementsClause) {
        implementsList = implementsClause.types.map((t) =>
          t.expression.getText(),
        );
      }
    }

    const properties: PropertyDeclarationNode[] = [];
    const methods: MethodDeclarationNode[] = [];
    let constructorNode:
      | {
          parameters: Array<{ name: string; type: string }>;
          body: ASTNode;
        }
      | undefined;

    const classTypeParams = new Set(
      (node.typeParameters ?? []).map((param) => param.name.getText()),
    );
    if (classTypeParams.size > 0) {
      this.genericTypeParamStack.push(classTypeParams);
    }

    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member)) {
        const property = this.visitPropertyDeclaration(member);
        if (property) properties.push(property);
      } else if (ts.isMethodDeclaration(member)) {
        const method = this.visitMethodDeclaration(member);
        if (method) methods.push(method);
      } else if (ts.isConstructorDeclaration(member)) {
        const params = member.parameters.map((param) => ({
          name: param.name.getText(),
          type: param.type ? param.type.getText() : "number",
        }));
        const body = member.body ? this.visitBlock(member.body) : undefined;
        if (body) {
          constructorNode = {
            parameters: params,
            body,
          };
        }
        for (const param of member.parameters) {
          const hasPropertyModifier =
            param.modifiers?.some(
              (mod) =>
                mod.kind === ts.SyntaxKind.PublicKeyword ||
                mod.kind === ts.SyntaxKind.PrivateKeyword ||
                mod.kind === ts.SyntaxKind.ProtectedKeyword ||
                mod.kind === ts.SyntaxKind.ReadonlyKeyword,
            ) ?? false;
          if (!hasPropertyModifier) continue;
          const propName = param.name.getText();
          if (properties.some((prop) => prop.name === propName)) continue;
          const propType = param.type
            ? this.mapTypeWithGenerics(param.type.getText(), param.type)
            : this.mapTypeWithGenerics("number");
          const isPublic =
            param.modifiers?.some(
              (mod) => mod.kind === ts.SyntaxKind.PublicKeyword,
            ) ?? false;
          properties.push({
            kind: ASTNodeKind.PropertyDeclaration,
            name: propName,
            type: propType,
            isPublic,
            isStatic: false,
          });
        }
      } else if (
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member) ||
        ts.isIndexSignatureDeclaration(member)
      ) {
      } else {
        this.reportUnsupportedNode(
          member,
          `Unsupported class member: ${ts.SyntaxKind[member.kind]}`,
          "Remove or refactor this class member.",
        );
      }
    }

    const result: ClassDeclarationNode = {
      kind: ASTNodeKind.ClassDeclaration,
      name: className,
      baseClass,
      implements: implementsList,
      decorators,
      properties,
      methods,
      constructor: constructorNode,
    };

    if (classTypeParams.size > 0) {
      this.genericTypeParamStack.pop();
    }

    return result;
  }

  private visitInterfaceDeclaration(
    node: ts.InterfaceDeclaration,
  ): InterfaceDeclarationNode {
    const name = node.name.text;
    this.typeMapper.registerTypeAlias(name, ObjectType);
    const properties: InterfaceDeclarationNode["properties"] = [];
    const methods: InterfaceDeclarationNode["methods"] = [];

    for (const member of node.members) {
      if (ts.isPropertySignature(member)) {
        const propName = member.name.getText();
        const propType = member.type
          ? this.mapTypeWithGenerics(member.type.getText(), member.type)
          : this.mapTypeWithGenerics("object");
        properties.push({ name: propName, type: propType });
      } else if (ts.isMethodSignature(member)) {
        const methodName = member.name.getText();
        const parameters = member.parameters.map((param) => ({
          name: param.name.getText(),
          type: param.type
            ? this.mapTypeWithGenerics(param.type.getText(), param.type)
            : this.mapTypeWithGenerics("object"),
        }));
        const returnType = member.type
          ? this.mapTypeWithGenerics(member.type.getText(), member.type)
          : this.mapTypeWithGenerics("void");
        methods.push({ name: methodName, parameters, returnType });
      }
    }

    return {
      kind: ASTNodeKind.InterfaceDeclaration,
      name,
      properties,
      methods,
    };
  }

  /**
   * Visit decorator
   */
  private visitDecorator(node: ts.Decorator): DecoratorNode {
    const expression = node.expression;
    if (ts.isCallExpression(expression)) {
      const name = expression.expression.getText();
      const args = expression.arguments.map((arg) => {
        if (ts.isStringLiteral(arg)) {
          return arg.text;
        }
        if (ts.isObjectLiteralExpression(arg)) {
          const result: Record<string, string> = {};
          for (const prop of arg.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const key = prop.name.getText().replace(/^['"]|['"]$/g, "");
            const value = prop.initializer;
            if (ts.isStringLiteral(value)) {
              result[key] = value.text;
            } else {
              result[key] = value.getText().replace(/^['"]|['"]$/g, "");
            }
          }
          return result;
        }
        const text = arg.getText();
        return text.replace(/^['"]|['"]$/g, "");
      });
      return {
        kind: ASTNodeKind.Decorator,
        name,
        arguments: args,
      };
    }
    return {
      kind: ASTNodeKind.Decorator,
      name: expression.getText(),
      arguments: [],
    };
  }
  private visitPropertyDeclaration(
    node: ts.PropertyDeclaration,
  ): PropertyDeclarationNode | undefined {
    if (!node.name) return undefined;
    const name = node.name.getText();

    let type: TypeSymbol = this.mapTypeWithGenerics("number");
    if (node.type) {
      type = this.mapTypeWithGenerics(node.type.getText(), node.type);
    } else if (node.initializer) {
      type = this.inferType(node.initializer);
    }

    const initializer = node.initializer
      ? this.visitExpression(node.initializer)
      : undefined;

    let syncMode: "None" | "Linear" | "Smooth" | undefined;
    let fieldChangeCallback: string | undefined;
    let isSerializeField = false;
    const rawDecorators = ts.canHaveDecorators(node)
      ? (ts.getDecorators(node) ?? [])
      : [];
    for (const decorator of rawDecorators) {
      const dec = this.visitDecorator(decorator);
      if (dec.name === "UdonSynced") {
        const mode = dec.arguments[0];
        if (
          mode === "Linear" ||
          mode === "Smooth" ||
          mode === "None" ||
          mode === undefined
        ) {
          syncMode = (mode ?? "None") as "None" | "Linear" | "Smooth";
        } else if (
          typeof mode === "object" &&
          mode !== null &&
          "syncMode" in (mode as Record<string, string>)
        ) {
          const sync = (mode as Record<string, string>).syncMode;
          if (sync === "Linear" || sync === "Smooth" || sync === "None") {
            syncMode = sync;
          }
        }
      }
      if (dec.name === "FieldChangeCallback") {
        const callback = dec.arguments[0];
        if (typeof callback === "string" && callback.length > 0) {
          fieldChangeCallback = callback;
        }
      }
      if (dec.name === "SerializeField") {
        isSerializeField = true;
      }
    }

    const isStatic = !!node.modifiers?.some(
      (mod) => mod.kind === ts.SyntaxKind.StaticKeyword,
    );
    const isPublic = !!(
      node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.PublicKeyword) ??
      true
    );

    return {
      kind: ASTNodeKind.PropertyDeclaration,
      name,
      type,
      initializer,
      isPublic,
      isStatic,
      syncMode,
      fieldChangeCallback,
      isSerializeField,
    };
  }

  /**
   * Visit method declaration
   */
  private visitMethodDeclaration(
    node: ts.MethodDeclaration,
  ): MethodDeclarationNode | undefined {
    if (!node.name || !node.body) return undefined;
    const name = node.name.getText();

    const methodTypeParams = new Set(
      (node.typeParameters ?? []).map((param) => param.name.getText()),
    );
    if (methodTypeParams.size > 0) {
      this.genericTypeParamStack.push(methodTypeParams);
    }

    const parameters = node.parameters.map((param) => {
      const paramName = param.name.getText();
      const paramType = param.type
        ? this.mapTypeWithGenerics(param.type.getText(), param.type)
        : this.mapTypeWithGenerics("number");
      return { name: paramName, type: paramType };
    });

    const returnType = node.type
      ? this.mapTypeWithGenerics(node.type.getText(), node.type)
      : this.mapTypeWithGenerics("void");

    const body = this.visitBlock(node.body);

    const isStatic = !!node.modifiers?.some(
      (mod) => mod.kind === ts.SyntaxKind.StaticKeyword,
    );
    const isPublic = !!(
      node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.PublicKeyword) ??
      true
    );

    const rawDecorators = ts.canHaveDecorators(node)
      ? (ts.getDecorators(node) ?? [])
      : [];
    const decoratorInfos = rawDecorators.map((decorator) =>
      this.visitDecorator(decorator),
    );
    const isRecursive = decoratorInfos.some(
      (decorator) => decorator.name === "RecursiveMethod",
    );
    const isExported = decoratorInfos.some(
      (decorator) => decorator.name === "UdonExport",
    );

    const result: MethodDeclarationNode = {
      kind: ASTNodeKind.MethodDeclaration,
      name,
      parameters,
      returnType,
      body,
      isPublic,
      isStatic,
      isRecursive,
      isExported,
    };

    if (methodTypeParams.size > 0) {
      this.genericTypeParamStack.pop();
    }

    return result;
  }

  /**
   * Visit enum declaration
   */
  private visitEnumDeclaration(node: ts.EnumDeclaration): EnumDeclarationNode {
    const members: EnumMemberNode[] = [];
    let autoValue = 0;
    let enumKind: EnumKind | null = null;
    for (const member of node.members) {
      let value: number | string;
      let memberKind: EnumKind;
      if (member.initializer) {
        const init = this.evaluateEnumInitializer(member.initializer);
        value = init.value;
        memberKind = init.kind;
      } else if (enumKind === "string") {
        this.reportTypeError(
          member,
          "String enum members must have string initializers",
          "Add a string initializer to each enum member.",
        );
        value = "";
        memberKind = "string";
      } else {
        value = autoValue;
        memberKind = "number";
      }

      if (enumKind && memberKind !== enumKind) {
        this.reportTypeError(
          member,
          "Mixed string and numeric enum members are not supported",
          "Use either all string or all numeric enum members.",
        );
      }

      if (!enumKind) {
        enumKind = memberKind;
      }

      members.push({
        kind: ASTNodeKind.EnumMember,
        name: member.name.getText(),
        value,
      });
      if (memberKind === "number" && typeof value === "number") {
        autoValue = value + 1;
      }
    }

    this.enumRegistry.register(
      node.name.text,
      enumKind ?? "number",
      members.map((m) => ({ name: m.name, value: m.value })),
    );

    return {
      kind: ASTNodeKind.EnumDeclaration,
      name: node.name.text,
      members,
    };
  }

  /**
   * Visit as expression
   */
  private visitAsExpression(node: ts.AsExpression): AsExpressionNode {
    return {
      kind: ASTNodeKind.AsExpression,
      expression: this.visitExpression(node.expression),
      targetType: node.type.getText(),
    };
  }

  /**
   * Infer type from expression
   */
  private inferType(node: ts.Expression): TypeSymbol {
    switch (node.kind) {
      case ts.SyntaxKind.NumericLiteral:
        return this.typeMapper.mapTypeScriptType("number");
      case ts.SyntaxKind.StringLiteral:
        return this.typeMapper.mapTypeScriptType("string");
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
        return this.typeMapper.mapTypeScriptType("boolean");
      case ts.SyntaxKind.BigIntLiteral:
        return this.typeMapper.mapTypeScriptType("bigint");
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.TypeAssertionExpression: {
        const asExpr = node as ts.AsExpression;
        if (ts.isConstTypeReference(asExpr.type)) {
          return this.inferType(asExpr.expression);
        }
        return this.mapTypeWithGenerics(asExpr.type.getText(), asExpr.type);
      }
      default:
        return this.typeMapper.mapTypeScriptType("number"); // Default fallback
    }
  }

  /**
   * Evaluate constant expressions for enum values
   */
  private evaluateEnumInitializer(node: ts.Expression): {
    value: number | string;
    kind: EnumKind;
  } {
    if (ts.isAsExpression(node)) {
      return this.evaluateEnumInitializer(node.expression);
    }
    if (ts.isTypeAssertionExpression(node)) {
      return this.evaluateEnumInitializer(node.expression);
    }
    if (ts.isParenthesizedExpression(node)) {
      return this.evaluateEnumInitializer(node.expression);
    }
    if (ts.isNumericLiteral(node)) {
      return { value: Number(node.text), kind: "number" };
    }
    if (ts.isStringLiteral(node)) {
      return { value: node.text, kind: "string" };
    }
    if (ts.isIdentifier(node)) {
      this.warnEnumInitializer(
        node,
        "Identifier enum initializers are not supported",
      );
      return { value: 0, kind: "number" };
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const inner = this.evaluateEnumInitializer(node.operand);
      if (inner.kind !== "number" || typeof inner.value !== "number") {
        this.warnEnumInitializer(
          node,
          "Non-numeric enum initializer is not supported",
        );
        return { value: 0, kind: "number" };
      }
      if (node.operator === ts.SyntaxKind.MinusToken) {
        return { value: -inner.value, kind: "number" };
      }
      if (node.operator === ts.SyntaxKind.PlusToken) {
        return { value: inner.value, kind: "number" };
      }
    }
    this.warnEnumInitializer(node, "Unsupported enum initializer");
    return { value: 0, kind: "number" };
  }

  private warnEnumInitializer(node: ts.Expression, message: string): void {
    const sourceFile = this.sourceFile ?? node.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const filePath = sourceFile.fileName || "<unknown>";
    console.warn(
      `Enum initializer warning: ${message} at ${filePath}:${position.line + 1}:${position.character + 1}`,
    );
  }

  private reportTypeError(
    node: ts.Node,
    message: string,
    suggestion?: string,
  ): void {
    const sourceFile = this.sourceFile ?? node.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const filePath = sourceFile.fileName || "<unknown>";
    this.errorCollector.add(
      new TranspileError(
        "TypeError",
        message,
        {
          filePath,
          line: position.line + 1,
          column: position.character + 1,
        },
        suggestion,
      ),
    );
  }

  /**
   * Report unsupported syntax without stopping parsing
   */
  /**
   * Report unsupported syntax and stop parsing
   */
  private reportUnsupportedNode(
    node: ts.Node,
    message: string,
    suggestion?: string,
  ): never {
    const sourceFile = this.sourceFile ?? node.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const filePath = sourceFile.fileName || "<unknown>";

    throw new TranspileError(
      "UnsupportedSyntax",
      message,
      {
        filePath,
        line: position.line + 1,
        column: position.character + 1,
      },
      suggestion,
    );
  }

  /**
   * Placeholder expression for unsupported nodes
   * (Unreachable if reportUnsupportedNode throws)
   */
  private createUnsupportedExpressionPlaceholder(): LiteralNode {
    return {
      kind: ASTNodeKind.Literal,
      value: 0,
      type: this.typeMapper.mapTypeScriptType("number"),
    };
  }
}

/**
 * Lightweight helper: extract class decorator names from source using ts.createSourceFile
 */
export function extractClassDecoratorsFromSource(
  sourceCode: string,
  filePath = "temp.ts",
): Array<{ className: string; decorators: string[] }> {
  const src = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.ES2020,
    true,
  );
  const results: Array<{ className: string; decorators: string[] }> = [];

  ts.forEachChild(src, (node) => {
    if (!ts.isClassDeclaration(node)) return;
    const name = node.name?.text ?? "";
    const decs: string[] = [];
    const decorators = ts.canHaveDecorators(node)
      ? (ts.getDecorators(node) ?? [])
      : [];
    for (const dec of decorators) {
      const expr = dec.expression as ts.Expression;
      if (ts.isCallExpression(expr)) {
        const e = expr.expression;
        if (ts.isIdentifier(e)) decs.push(e.escapedText?.toString() ?? "");
      } else if (ts.isIdentifier(expr)) {
        decs.push(expr.escapedText?.toString() ?? "");
      } else {
        decs.push(expr.getText());
      }
    }
    results.push({ className: name, decorators: decs });
  });

  return results;
}

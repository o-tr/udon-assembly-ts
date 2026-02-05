import * as ts from "typescript";
import {
  ArrayTypeSymbol,
  ObjectType,
  PrimitiveTypes,
  type TypeSymbol,
} from "../../type_symbols.js";
import {
  type ArrayAccessExpressionNode,
  type ASTNode,
  ASTNodeKind,
  type BlockStatementNode,
  type BreakStatementNode,
  type CaseClauseNode,
  type ContinueStatementNode,
  type DoWhileStatementNode,
  type ForOfStatementNode,
  type ForStatementNode,
  type IdentifierNode,
  type IfStatementNode,
  type InterfaceDeclarationNode,
  type LiteralNode,
  type PropertyAccessExpressionNode,
  type ReturnStatementNode,
  type SwitchStatementNode,
  type ThrowStatementNode,
  type TryCatchStatementNode,
  type VariableDeclarationNode,
  type WhileStatementNode,
} from "../../types.js";
import type { TypeScriptParser } from "../type_script_parser.js";

export function visitNode(
  this: TypeScriptParser,
  node: ts.Node,
): ASTNode | undefined {
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

export function visitVariableStatement(
  this: TypeScriptParser,
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

export function visitTypeAliasDeclaration(
  this: TypeScriptParser,
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

export function visitIfStatement(
  this: TypeScriptParser,
  node: ts.IfStatement,
): IfStatementNode {
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

export function visitWhileStatement(
  this: TypeScriptParser,
  node: ts.WhileStatement,
): WhileStatementNode {
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

export function visitSwitchStatement(
  this: TypeScriptParser,
  node: ts.SwitchStatement,
): SwitchStatementNode {
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

export function visitDoWhileStatement(
  this: TypeScriptParser,
  node: ts.DoStatement,
): DoWhileStatementNode {
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

export function visitBreakStatement(this: TypeScriptParser): BreakStatementNode {
  return {
    kind: ASTNodeKind.BreakStatement,
  };
}

export function visitContinueStatement(
  this: TypeScriptParser,
): ContinueStatementNode {
  return {
    kind: ASTNodeKind.ContinueStatement,
  };
}

export function visitReturnStatement(
  this: TypeScriptParser,
  node: ts.ReturnStatement,
): ReturnStatementNode {
  return {
    kind: ASTNodeKind.ReturnStatement,
    value: node.expression ? this.visitExpression(node.expression) : undefined,
  };
}

export function visitTryStatement(
  this: TypeScriptParser,
  node: ts.TryStatement,
): TryCatchStatementNode {
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

export function visitThrowStatement(
  this: TypeScriptParser,
  node: ts.ThrowStatement,
): ThrowStatementNode {
  return {
    kind: ASTNodeKind.ThrowStatement,
    expression: this.visitExpression(node.expression),
  };
}

export function visitForStatement(
  this: TypeScriptParser,
  node: ts.ForStatement,
): ForStatementNode {
  this.symbolTable.enterScope();

  const initializer = node.initializer
    ? ts.isVariableDeclarationList(node.initializer)
      ? this.visitVariableStatement(
          ts.factory.createVariableStatement(undefined, node.initializer),
        )
      : this.visitExpression(node.initializer as ts.Expression)
    : undefined;

  const condition = node.condition ? this.visitExpression(node.condition) : undefined;
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

export function visitForOfStatement(
  this: TypeScriptParser,
  node: ts.ForOfStatement,
): ForOfStatementNode {
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

export function visitBlock(
  this: TypeScriptParser,
  node: ts.Block,
): BlockStatementNode {
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

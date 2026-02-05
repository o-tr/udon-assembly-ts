import * as ts from "typescript";
import type { TypeSymbol } from "../../type_symbols.js";
import {
  type ArrayLiteralElementNode,
  type ArrayLiteralExpressionNode,
  type ASTNode,
  ASTNodeKind,
  type AssignmentExpressionNode,
  type BinaryExpressionNode,
  type CallExpressionNode,
  type ConditionalExpressionNode,
  type DeleteExpressionNode,
  type IdentifierNode,
  type LiteralNode,
  type NameofExpressionNode,
  type NullCoalescingExpressionNode,
  type ObjectLiteralExpressionNode,
  type ObjectLiteralPropertyNode,
  type OptionalChainingExpressionNode,
  type PropertyAccessExpressionNode,
  type SuperExpressionNode,
  type TemplateExpressionNode,
  type ThisExpressionNode,
  type TypeofExpressionNode,
  type UnaryExpressionNode,
  type UpdateExpressionNode,
} from "../../types.js";
import type { TypeScriptParser } from "../type_script_parser.js";

export function visitExpression(
  this: TypeScriptParser,
  node: ts.Expression,
): ASTNode {
  switch (node.kind) {
    case ts.SyntaxKind.BinaryExpression:
      return this.visitBinaryExpression(node as ts.BinaryExpression);
    case ts.SyntaxKind.ConditionalExpression:
      return this.visitConditionalExpression(node as ts.ConditionalExpression);
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

export function visitBinaryExpression(
  this: TypeScriptParser,
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

export function visitConditionalExpression(
  this: TypeScriptParser,
  node: ts.ConditionalExpression,
): ConditionalExpressionNode {
  return {
    kind: ASTNodeKind.ConditionalExpression,
    condition: this.visitExpression(node.condition),
    whenTrue: this.visitExpression(node.whenTrue),
    whenFalse: this.visitExpression(node.whenFalse),
  };
}

export function visitTemplateExpression(
  this: TypeScriptParser,
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

export function visitUnaryExpression(
  this: TypeScriptParser,
  node: ts.PrefixUnaryExpression,
): UnaryExpressionNode {
  return {
    kind: ASTNodeKind.UnaryExpression,
    operator: node.operator === ts.SyntaxKind.ExclamationToken ? "!" : "-",
    operand: this.visitExpression(node.operand),
  };
}

export function visitUpdateExpression(
  this: TypeScriptParser,
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

export function visitFunctionLiteralExpression(
  this: TypeScriptParser,
): LiteralNode {
  return {
    kind: ASTNodeKind.Literal,
    value: 0,
    type: this.typeMapper.mapTypeScriptType("object"),
  };
}

export function visitRegexLiteralExpression(
  this: TypeScriptParser,
  _node: ts.RegularExpressionLiteral,
): LiteralNode {
  return {
    kind: ASTNodeKind.Literal,
    value: 0,
    type: this.typeMapper.mapTypeScriptType("object"),
  };
}

export function visitNonNullExpression(
  this: TypeScriptParser,
  node: ts.NonNullExpression,
): ASTNode {
  return this.visitExpression(node.expression);
}

export function visitIdentifier(
  this: TypeScriptParser,
  node: ts.Identifier,
): IdentifierNode {
  return {
    kind: ASTNodeKind.Identifier,
    name: node.text,
  };
}

export function visitThisExpression(
  this: TypeScriptParser,
): ThisExpressionNode {
  return {
    kind: ASTNodeKind.ThisExpression,
  };
}

export function visitSuperExpression(
  this: TypeScriptParser,
): SuperExpressionNode {
  return {
    kind: ASTNodeKind.SuperExpression,
  };
}

export function visitObjectLiteralExpression(
  this: TypeScriptParser,
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

export function visitDeleteExpression(
  this: TypeScriptParser,
  node: ts.DeleteExpression,
): DeleteExpressionNode {
  return {
    kind: ASTNodeKind.DeleteExpression,
    target: this.visitExpression(node.expression),
  };
}

export function visitPropertyAccessExpression(
  this: TypeScriptParser,
  node: ts.PropertyAccessExpression,
): PropertyAccessExpressionNode {
  return {
    kind: ASTNodeKind.PropertyAccessExpression,
    object: this.visitExpression(node.expression),
    property: node.name.getText(),
  };
}

export function visitOptionalChainingExpression(
  this: TypeScriptParser,
  node: ts.PropertyAccessChain,
): OptionalChainingExpressionNode {
  return {
    kind: ASTNodeKind.OptionalChainingExpression,
    object: this.visitExpression(node.expression),
    property: node.name.getText(),
  };
}

export function visitLiteral(
  this: TypeScriptParser,
  node: ts.Expression,
): LiteralNode {
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
      throw new Error(`Unsupported literal kind: ${ts.SyntaxKind[node.kind]}`);
  }

  return {
    kind: ASTNodeKind.Literal,
    value,
    type,
  };
}

export function visitCallExpression(
  this: TypeScriptParser,
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

export function visitNameofExpression(
  this: TypeScriptParser,
  node: ts.CallExpression,
): NameofExpressionNode {
  const arg = node.arguments[0];
  const name = ts.isIdentifier(arg) ? arg.text : arg.getText();
  return {
    kind: ASTNodeKind.NameofExpression,
    name,
  };
}

export function visitTypeofExpression(
  this: TypeScriptParser,
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

export function visitElementAccessExpression(
  this: TypeScriptParser,
  node: ts.ElementAccessExpression,
) {
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

export function visitNewExpression(
  this: TypeScriptParser,
  node: ts.NewExpression,
): CallExpressionNode {
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

export function visitArrayLiteralExpression(
  this: TypeScriptParser,
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

export function visitParenthesizedExpression(
  this: TypeScriptParser,
  node: ts.ParenthesizedExpression,
): ASTNode {
  return this.visitExpression(node.expression);
}

export function visitAsExpression(
  this: TypeScriptParser,
  node: ts.AsExpression,
) {
  return {
    kind: ASTNodeKind.AsExpression,
    expression: this.visitExpression(node.expression),
    targetType: node.type.getText(),
  };
}

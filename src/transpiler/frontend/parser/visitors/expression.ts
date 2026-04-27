import * as ts from "typescript";
import { isStep10MetricsEnabled } from "../../type_resolution_metrics.js";
import {
  ExternTypes,
  ObjectType,
  type TypeSymbol,
} from "../../type_symbols.js";
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
  type FunctionExpressionNode,
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
      return this.visitThisExpression(node);
    case ts.SyntaxKind.SuperKeyword:
      return this.visitSuperExpression(node);
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.FunctionExpression:
      return this.visitFunctionLiteralExpression(
        node as ts.ArrowFunction | ts.FunctionExpression,
      );
    default:
      if (isStep10MetricsEnabled()) {
        if (node.kind === ts.SyntaxKind.TaggedTemplateExpression) {
          return this.visitTemplateExpression(
            (node as ts.TaggedTemplateExpression).template,
          );
        }
        if (
          node.kind === ts.SyntaxKind.ClassExpression ||
          node.kind === ts.SyntaxKind.VoidExpression ||
          node.kind === ts.SyntaxKind.AwaitExpression ||
          node.kind === ts.SyntaxKind.YieldExpression ||
          node.kind === ts.SyntaxKind.SpreadElement ||
          node.kind === ts.SyntaxKind.MetaProperty
        ) {
          return this.createUnsupportedExpressionPlaceholder(node);
        }
      }
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
    return this.attachLoc(node, {
      kind: ASTNodeKind.AssignmentExpression,
      target: this.visitExpression(node.left),
      value: this.visitExpression(node.right),
    });
  }

  if (operator === "??") {
    const coalesceNode: NullCoalescingExpressionNode = this.attachLoc(node, {
      kind: ASTNodeKind.NullCoalescingExpression,
      left: this.visitExpression(node.left),
      right: this.visitExpression(node.right),
    });
    return coalesceNode;
  }

  return this.attachLoc(node, {
    kind: ASTNodeKind.BinaryExpression,
    operator,
    left: this.visitExpression(node.left),
    right: this.visitExpression(node.right),
  });
}

export function visitConditionalExpression(
  this: TypeScriptParser,
  node: ts.ConditionalExpression,
): ConditionalExpressionNode {
  return this.attachLoc(node, {
    kind: ASTNodeKind.ConditionalExpression,
    condition: this.visitExpression(node.condition),
    whenTrue: this.visitExpression(node.whenTrue),
    whenFalse: this.visitExpression(node.whenFalse),
  });
}

export function visitTemplateExpression(
  this: TypeScriptParser,
  node: ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral,
): TemplateExpressionNode {
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return this.attachLoc(node, {
      kind: ASTNodeKind.TemplateExpression,
      parts: [{ kind: "text", value: node.text }],
    });
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

  return this.attachLoc(node, {
    kind: ASTNodeKind.TemplateExpression,
    parts,
  });
}

export function visitUnaryExpression(
  this: TypeScriptParser,
  node: ts.PrefixUnaryExpression,
): UnaryExpressionNode {
  return this.attachLoc(node, {
    kind: ASTNodeKind.UnaryExpression,
    operator: node.operator === ts.SyntaxKind.ExclamationToken ? "!" : "-",
    operand: this.visitExpression(node.operand),
  });
}

export function visitUpdateExpression(
  this: TypeScriptParser,
  node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
): UpdateExpressionNode {
  const operator = node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
  const operand = this.visitExpression(node.operand);
  return this.attachLoc(node, {
    kind: ASTNodeKind.UpdateExpression,
    operator,
    operand,
    isPostfix: ts.isPostfixUnaryExpression(node),
  });
}

export function visitFunctionLiteralExpression(
  this: TypeScriptParser,
  node: ts.ArrowFunction | ts.FunctionExpression,
): FunctionExpressionNode {
  const parameters = node.parameters.map((param) => {
    const name = param.name.getText();
    const type = param.type
      ? this.mapTypeWithGenerics(param.type.getText(), param.type)
      : ExternTypes.dataDictionary;
    const initializer = param.initializer
      ? this.parseParameterInitializer(param.initializer, param.type)
      : undefined;
    return { name, type, ...(initializer ? { initializer } : {}) };
  });

  const body = ts.isBlock(node.body)
    ? this.visitBlock(node.body)
    : this.visitExpression(node.body as ts.Expression);
  const returnType = node.type
    ? this.mapTypeWithGenerics(node.type.getText(), node.type)
    : undefined;

  return this.attachLoc(node, {
    kind: ASTNodeKind.FunctionExpression,
    parameters,
    body,
    isArrow: ts.isArrowFunction(node),
    returnType,
  });
}

export function visitRegexLiteralExpression(
  this: TypeScriptParser,
  _node: ts.RegularExpressionLiteral,
): LiteralNode {
  return this.attachLoc(_node, {
    kind: ASTNodeKind.Literal,
    value: 0,
    type: ExternTypes.dataDictionary,
  });
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
  return this.attachLoc(node, {
    kind: ASTNodeKind.Identifier,
    name: node.text,
  });
}

export function visitThisExpression(
  this: TypeScriptParser,
  node?: ts.Node,
): ThisExpressionNode {
  const result: ThisExpressionNode = {
    kind: ASTNodeKind.ThisExpression,
  };
  return node ? this.attachLoc(node, result) : result;
}

export function visitSuperExpression(
  this: TypeScriptParser,
  node?: ts.Node,
): SuperExpressionNode {
  const result: SuperExpressionNode = {
    kind: ASTNodeKind.SuperExpression,
  };
  return node ? this.attachLoc(node, result) : result;
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
        if (isStep10MetricsEnabled()) {
          properties.push({
            kind: "property",
            key: prop.name.getText(),
            value: this.visitExpression(prop.initializer),
          });
          continue;
        }
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

  return this.attachLoc(node, {
    kind: ASTNodeKind.ObjectLiteralExpression,
    properties,
  });
}

export function visitDeleteExpression(
  this: TypeScriptParser,
  node: ts.DeleteExpression,
): DeleteExpressionNode {
  return this.attachLoc(node, {
    kind: ASTNodeKind.DeleteExpression,
    target: this.visitExpression(node.expression),
  });
}

export function visitPropertyAccessExpression(
  this: TypeScriptParser,
  node: ts.PropertyAccessExpression,
): PropertyAccessExpressionNode {
  return this.attachLoc(node, {
    kind: ASTNodeKind.PropertyAccessExpression,
    object: this.visitExpression(node.expression),
    property: node.name.getText(),
  });
}

export function visitOptionalChainingExpression(
  this: TypeScriptParser,
  node: ts.PropertyAccessChain,
): OptionalChainingExpressionNode {
  return this.attachLoc(node, {
    kind: ASTNodeKind.OptionalChainingExpression,
    object: this.visitExpression(node.expression),
    property: node.name.getText(),
  });
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
      type = ExternTypes.dataDictionary;
      break;
    default:
      throw new Error(`Unsupported literal kind: ${ts.SyntaxKind[node.kind]}`);
  }

  return this.attachLoc(node, {
    kind: ASTNodeKind.Literal,
    value,
    type,
  });
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

  return this.attachLoc(node, {
    kind: ASTNodeKind.CallExpression,
    callee,
    arguments: args,
    typeArguments: node.typeArguments?.map((arg) =>
      this.mapTypeWithGenerics(arg.getText(), arg),
    ),
  });
}

export function visitNameofExpression(
  this: TypeScriptParser,
  node: ts.CallExpression,
): NameofExpressionNode {
  if (node.arguments.length === 0) {
    this.reportTypeError(
      node,
      "nameof() requires exactly one argument",
      "Provide an identifier as argument.",
    );
    return this.attachLoc(node, {
      kind: ASTNodeKind.NameofExpression,
      name: "",
    });
  }
  const arg = node.arguments[0];
  let name: string;
  if (ts.isIdentifier(arg)) {
    name = arg.text;
  } else if (ts.isPropertyAccessExpression(arg)) {
    // nameof(this.myField) → "myField" (last identifier only, matching C# semantics)
    name = arg.name.text;
  } else {
    name = arg.getText();
  }
  return this.attachLoc(node, {
    kind: ASTNodeKind.NameofExpression,
    name,
  });
}

export function visitTypeofExpression(
  this: TypeScriptParser,
  node: ts.TypeOfExpression,
): TypeofExpressionNode {
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) {
    inner = inner.expression;
  }
  let typeName = "object";
  let typeSymbol: TypeSymbol = ObjectType;
  if (ts.isIdentifier(inner)) {
    const symbol = this.symbolTable.lookup(inner.text);
    if (symbol) {
      typeName = symbol.type.name;
      typeSymbol = symbol.type;
    }
  }
  return this.attachLoc(node, {
    kind: ASTNodeKind.TypeofExpression,
    typeName,
    typeSymbol,
  });
}

export function visitElementAccessExpression(
  this: TypeScriptParser,
  node: ts.ElementAccessExpression,
) {
  const arrayExpr = this.visitExpression(node.expression);
  if (!node.argumentExpression) {
    this.reportTypeError(
      node,
      "Element access expression requires an index argument",
      "Provide an index inside the brackets.",
    );
    return this.attachLoc(node, {
      kind: ASTNodeKind.ArrayAccessExpression,
      array: arrayExpr,
      index: this.createUnsupportedExpressionPlaceholder(node),
    });
  }
  const indexExpr = this.visitExpression(node.argumentExpression);
  return this.attachLoc(node, {
    kind: ASTNodeKind.ArrayAccessExpression,
    array: arrayExpr,
    index: indexExpr,
  });
}

export function visitNewExpression(
  this: TypeScriptParser,
  node: ts.NewExpression,
): CallExpressionNode {
  // Treat `new X(args)` as a call expression for now
  const callee = this.visitExpression(node.expression as ts.Expression);
  const args = (node.arguments ?? []).map((arg) => this.visitExpression(arg));
  return this.attachLoc(node, {
    kind: ASTNodeKind.CallExpression,
    callee,
    arguments: args,
    typeArguments: node.typeArguments?.map((arg) =>
      this.mapTypeWithGenerics(arg.getText(), arg),
    ),
    isNew: true,
  });
}

export function visitArrayLiteralExpression(
  this: TypeScriptParser,
  node: ts.ArrayLiteralExpression,
  typeHint?: TypeSymbol,
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

  return this.attachLoc(node, {
    kind: ASTNodeKind.ArrayLiteralExpression,
    elements,
    typeHint,
  });
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
  const targetTypeText = node.type.getText();
  // `as const` is a brand-strip handled by source-text comparison in the IR.
  // Skip type resolution because TS represents `const` as a TypeReference whose
  // resolution depends on the operand's literal type — IR never reads the
  // symbol in this branch.
  const targetTypeSymbol =
    targetTypeText === "const"
      ? ObjectType
      : this.mapTypeWithGenerics(targetTypeText, node.type);
  return this.attachLoc(node, {
    kind: ASTNodeKind.AsExpression,
    expression: this.visitExpression(node.expression),
    targetType: targetTypeText,
    targetTypeSymbol,
  });
}

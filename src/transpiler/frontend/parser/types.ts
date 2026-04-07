import * as ts from "typescript";
import type { TypeSymbol } from "../type_symbols.js";
import {
  ArrayTypeSymbol,
  CollectionTypeSymbol,
  ExternTypes,
  GenericTypeParameterSymbol,
  InterfaceTypeSymbol,
  ObjectType,
  PrimitiveTypes,
} from "../type_symbols.js";
import type { TypeScriptParser } from "./type_script_parser.js";

function splitTopLevelMembers(body: string): string[] {
  const members: string[] = [];
  let current = "";
  let angleDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (const ch of body) {
    if (quote) {
      current += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "<") angleDepth += 1;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);

    const isTopLevelSeparator =
      (ch === ";" || ch === ",") &&
      angleDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenDepth === 0;
    if (isTopLevelSeparator) {
      const member = current.trim();
      if (member) members.push(member);
      current = "";
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) members.push(tail);
  return members;
}

function findTopLevelColon(member: string): number {
  let angleDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let i = 0; i < member.length; i += 1) {
    const ch = member[i];
    if (!ch) continue;

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "<") angleDepth += 1;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (
      ch === ":" &&
      angleDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenDepth === 0
    ) {
      return i;
    }
  }

  return -1;
}

function parseTypeLiteralFromText(
  parser: TypeScriptParser,
  trimmedTypeText: string,
): InterfaceTypeSymbol | null {
  const body = trimmedTypeText.slice(1, -1).trim();
  if (!body) return null;

  const members = splitTopLevelMembers(body);
  if (members.length === 0) return null;

  const propertyMap = new Map<string, TypeSymbol>();
  for (const rawMember of members) {
    const member = rawMember.trim();
    if (!member) continue;
    if (member.startsWith("[")) {
      // Index signatures are handled as DataDictionary fallback.
      return null;
    }
    if (member.includes("(")) {
      // Method signatures are not safely handled by string fallback parser.
      return null;
    }

    const colonIndex = findTopLevelColon(member);
    if (colonIndex < 0) return null;

    let propName = member.slice(0, colonIndex).trim();
    const propTypeText = member.slice(colonIndex + 1).trim();
    if (!propName || !propTypeText) return null;

    if (propName.startsWith("readonly ")) {
      propName = propName.slice("readonly ".length).trim();
    }
    if (propName.endsWith("?")) {
      propName = propName.slice(0, -1).trim();
    }
    if (
      (propName.startsWith('"') && propName.endsWith('"')) ||
      (propName.startsWith("'") && propName.endsWith("'"))
    ) {
      propName = propName.slice(1, -1);
    }
    if (!propName || /\s/.test(propName)) return null;

    propertyMap.set(propName, parser.mapTypeWithGenerics(propTypeText));
  }

  if (propertyMap.size === 0) return null;
  const anonName = `__anon_${++parser.anonTypeCounter}`;
  return new InterfaceTypeSymbol(anonName, new Map(), propertyMap);
}

export function mapTypeWithGenerics(
  this: TypeScriptParser,
  typeText: string,
  node?: ts.Node,
): TypeSymbol {
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

  if (node && ts.isArrayTypeNode(node)) {
    let current: ts.TypeNode = node;
    let dimensions = 0;
    while (ts.isArrayTypeNode(current)) {
      dimensions += 1;
      current = current.elementType;
    }
    const elementType = this.mapTypeWithGenerics(current.getText(), current);
    return new ArrayTypeSymbol(elementType, dimensions);
  }

  if (node && ts.isTypeOperatorNode(node)) {
    if (node.operator === ts.SyntaxKind.ReadonlyKeyword) {
      return this.mapTypeWithGenerics(node.type.getText(), node.type);
    }
  }

  if (node && ts.isTypeReferenceNode(node)) {
    const refName = node.typeName.getText();
    if (refName === "Array" || refName === "ReadonlyArray") {
      const arg = node.typeArguments?.[0];
      const elementType = arg
        ? this.mapTypeWithGenerics(arg.getText(), arg)
        : ObjectType;
      return new ArrayTypeSymbol(elementType);
    }
  }

  if (node && ts.isTupleTypeNode(node)) {
    return new ArrayTypeSymbol(ObjectType);
  }

  if (node && ts.isTypeLiteralNode(node)) {
    // Build an InterfaceTypeSymbol for anonymous type literals so object
    // literal values receive inline heap variables instead of DataDictionary.
    const propertyMap = new Map<string, TypeSymbol>();
    for (const member of node.members) {
      if (ts.isPropertySignature(member) && member.name) {
        const propName = member.name.getText();
        const propType = member.type
          ? this.mapTypeWithGenerics(member.type.getText(), member.type)
          : ObjectType;
        propertyMap.set(propName, propType);
      }
    }
    if (propertyMap.size > 0) {
      // Each occurrence gets a unique name (per-occurrence, not structural).
      // Structurally identical type literals in different positions produce
      // distinct InterfaceTypeSymbols. This is acceptable because call-site
      // type propagation (currentExpectedType) is the primary mechanism for
      // matching object literals to their target types.
      const name = `__anon_${++this.anonTypeCounter}`;
      return new InterfaceTypeSymbol(name, new Map(), propertyMap);
    }
    return ExternTypes.dataDictionary;
  }

  if (node && ts.isUnionTypeNode(node)) {
    if (node.types.every((t) => this.isStringTypeNode(t))) {
      return PrimitiveTypes.string;
    }
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const parsedTypeLiteral = parseTypeLiteralFromText(this, trimmed);
    if (parsedTypeLiteral) return parsedTypeLiteral;
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
        return ExternTypes.dataDictionary;
      case "Map":
      case "ReadonlyMap":
        return new CollectionTypeSymbol(
          ExternTypes.dataDictionary.name,
          undefined,
          this.mapTypeWithGenerics(args[0] ?? "object"),
          this.mapTypeWithGenerics(args[1] ?? "object"),
        );
      case "Set":
      case "ReadonlySet":
        return new CollectionTypeSymbol(
          ExternTypes.dataDictionary.name,
          this.mapTypeWithGenerics(args[0] ?? "object"),
          this.mapTypeWithGenerics(args[0] ?? "object"),
          PrimitiveTypes.boolean,
        );
    }
  }

  return this.typeMapper.mapTypeScriptType(trimmed);
}

export function isStringTypeNode(
  this: TypeScriptParser,
  node: ts.TypeNode,
): boolean {
  if (node.kind === ts.SyntaxKind.StringKeyword) return true;
  if (ts.isLiteralTypeNode(node)) {
    return ts.isStringLiteral(node.literal);
  }
  if (ts.isUnionTypeNode(node)) {
    return node.types.every((t) => this.isStringTypeNode(t));
  }
  return false;
}

export function resolveGenericParam(
  this: TypeScriptParser,
  typeText: string,
): TypeSymbol | undefined {
  for (let i = this.genericTypeParamStack.length - 1; i >= 0; i -= 1) {
    const scope = this.genericTypeParamStack[i];
    if (scope?.has(typeText)) {
      return new GenericTypeParameterSymbol(typeText);
    }
  }
  return undefined;
}

export function parseGenericType(
  this: TypeScriptParser,
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

export function inferType(
  this: TypeScriptParser,
  node: ts.Expression,
): TypeSymbol {
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
    case ts.SyntaxKind.Identifier: {
      const identifier = node as ts.Identifier;
      const symbol = this.symbolTable.lookup(identifier.text);
      return symbol?.type ?? ObjectType;
    }
    case ts.SyntaxKind.PropertyAccessExpression: {
      const access = node as ts.PropertyAccessExpression;
      let baseType: TypeSymbol | null = null;
      if (ts.isIdentifier(access.expression)) {
        const symbol = this.symbolTable.lookup(access.expression.text);
        baseType = symbol?.type ?? null;
      } else if (ts.isPropertyAccessExpression(access.expression)) {
        baseType = this.inferType(access.expression);
      }
      if (baseType instanceof InterfaceTypeSymbol) {
        return baseType.properties.get(access.name.getText()) ?? ObjectType;
      }
      return ObjectType;
    }
    case ts.SyntaxKind.ElementAccessExpression: {
      const access = node as ts.ElementAccessExpression;
      if (ts.isIdentifier(access.expression)) {
        const symbol = this.symbolTable.lookup(access.expression.text);
        const type = symbol?.type;
        if (type instanceof ArrayTypeSymbol) {
          return type.elementType;
        }
      }
      if (ts.isPropertyAccessExpression(access.expression)) {
        const propertyType = this.inferType(access.expression);
        if (propertyType instanceof ArrayTypeSymbol) {
          return propertyType.elementType;
        }
      }
      return this.typeMapper.mapTypeScriptType("object");
    }
    default:
      return this.typeMapper.mapTypeScriptType("number"); // Default fallback
  }
}

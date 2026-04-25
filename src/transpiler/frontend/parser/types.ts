import * as ts from "typescript";
import { TranspileError } from "../../errors/transpile_errors.js";
import type { TypeSymbol } from "../type_symbols.js";
import {
  ArrayTypeSymbol,
  CollectionTypeSymbol,
  ExternTypes,
  GenericTypeParameterSymbol,
  InterfaceTypeSymbol,
  ObjectType,
  type PrimitiveTypeSymbol,
  PrimitiveTypes,
  UDON_BRANDED_TYPE_MAP,
} from "../type_symbols.js";
import type { TypeScriptParser } from "./type_script_parser.js";

function getTypeLiteralPropertyName(
  name: ts.PropertyName,
): { propName: string } | null {
  if (ts.isIdentifier(name) || ts.isNumericLiteral(name)) {
    return { propName: name.text };
  }
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return { propName: name.text };
  }
  return null;
}

function isInlineSafePropertyName(propName: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(propName);
}

function tryResolveBrandedPrimitive(
  node: ts.IntersectionTypeNode,
): PrimitiveTypeSymbol | null {
  for (const constituent of node.types) {
    if (ts.isTypeLiteralNode(constituent)) {
      for (const member of constituent.members) {
        if (
          ts.isPropertySignature(member) &&
          member.name.getText() === "__brand" &&
          member.type &&
          ts.isLiteralTypeNode(member.type) &&
          ts.isStringLiteral(member.type.literal)
        ) {
          const brandName = member.type.literal.text;
          const mapped = UDON_BRANDED_TYPE_MAP.get(brandName);
          if (mapped) return mapped;
        }
      }
    }
  }
  for (const constituent of node.types) {
    if (ts.isTypeReferenceNode(constituent)) {
      const refName = constituent.typeName.getText();
      const mapped = UDON_BRANDED_TYPE_MAP.get(refName);
      if (mapped) return mapped;
    }
  }
  return null;
}

const typeLiteralSourceFileCache = new Map<string, ts.SourceFile>();

function getOrCreateTypeLiteralSourceFile(
  trimmedTypeText: string,
): ts.SourceFile {
  let cached = typeLiteralSourceFileCache.get(trimmedTypeText);
  if (!cached) {
    const sourceText = `type __TypeLiteralFallback = ${trimmedTypeText};`;
    cached = ts.createSourceFile(
      "__type_literal_fallback.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    typeLiteralSourceFileCache.set(trimmedTypeText, cached);
  }
  return cached;
}

function parseTypeLiteralFromText(
  parser: TypeScriptParser,
  trimmedTypeText: string,
): InterfaceTypeSymbol | null {
  const sourceFile = getOrCreateTypeLiteralSourceFile(trimmedTypeText);
  const typeAlias = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement),
  );
  if (!typeAlias || !ts.isTypeLiteralNode(typeAlias.type)) return null;
  const typeLiteral = typeAlias.type;
  if (typeLiteral.members.length === 0) return null;

  const propertyMap = new Map<string, TypeSymbol>();
  for (const member of typeLiteral.members) {
    if (!ts.isPropertySignature(member) || !member.name) {
      // Keep index signatures/method signatures/etc. on DataDictionary fallback.
      return null;
    }

    const nameInfo = getTypeLiteralPropertyName(member.name);
    if (!nameInfo) return null;
    const { propName } = nameInfo;
    if (!propName || !isInlineSafePropertyName(propName)) return null;

    const propType = member.type
      ? parser.mapTypeWithGenerics(member.type.getText(sourceFile), member.type)
      : ObjectType;
    propertyMap.set(propName, propType);
  }

  if (propertyMap.size === 0) return null;
  const anonName = `__anon_${++parser.anonTypeCounter}`;
  return new InterfaceTypeSymbol(anonName, new Map(), propertyMap);
}

function isNullishUnionBranch(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
    return true;
  }
  return (
    ts.isLiteralTypeNode(node) &&
    node.literal.kind === ts.SyntaxKind.NullKeyword
  );
}

function isAnonymousInterface(
  symbol: TypeSymbol,
): symbol is InterfaceTypeSymbol {
  return (
    symbol instanceof InterfaceTypeSymbol && symbol.name.startsWith("__anon")
  );
}

function isCompatibleUnionPropertyType(
  left: TypeSymbol,
  right: TypeSymbol,
): boolean {
  if (left === right) return true;
  if (isAnonymousInterface(left) && isAnonymousInterface(right)) {
    if (left.properties.size !== right.properties.size) return false;
    for (const [name, leftType] of left.properties) {
      const rightType = right.properties.get(name);
      if (!rightType) return false;
      if (!isCompatibleUnionPropertyType(leftType, rightType)) return false;
    }
    return true;
  }
  return left.name === right.name && left.udonType === right.udonType;
}

function getTypeSignature(type: TypeSymbol): string {
  if (isAnonymousInterface(type)) {
    const props = [...type.properties.entries()]
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
      .map(([name, inner]) => `${name}:${getTypeSignature(inner)}`)
      .join(",");
    return `{${props}}`;
  }
  return `${type.name}@${type.udonType}`;
}

function getUnionSignature(properties: Map<string, TypeSymbol>): string {
  return [...properties.entries()]
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([name, type]) => `${name}:${getTypeSignature(type)}`)
    .join("|");
}

export function resolveStructuralUnionType(
  this: TypeScriptParser,
  node: ts.UnionTypeNode,
): InterfaceTypeSymbol | TypeSymbol | null {
  const branches = node.types.filter((branch) => !isNullishUnionBranch(branch));
  if (branches.length === 0) return null;
  if (branches.length === 1) {
    return this.mapTypeWithGenerics(branches[0].getText(), branches[0]);
  }

  const branchSymbols = branches.map((branch) =>
    this.mapTypeWithGenerics(branch.getText(), branch),
  );
  if (
    !branchSymbols.every(
      (symbol) =>
        symbol instanceof InterfaceTypeSymbol && symbol.properties.size > 0,
    )
  ) {
    return null;
  }
  const interfaceBranches = branchSymbols as InterfaceTypeSymbol[];

  const propertyNames = new Set<string>();
  for (const symbol of interfaceBranches) {
    for (const name of symbol.properties.keys()) {
      propertyNames.add(name);
    }
  }

  const mergedProperties = new Map<string, TypeSymbol>();
  for (const name of [...propertyNames].sort()) {
    const propertyTypes = interfaceBranches
      .map((symbol) => symbol.properties.get(name))
      .filter((prop): prop is TypeSymbol => prop !== undefined);

    if (propertyTypes.length > 1) {
      const [first, ...rest] = propertyTypes;
      if (!rest.every((prop) => isCompatibleUnionPropertyType(first, prop))) {
        return null;
      }
    }
    mergedProperties.set(name, propertyTypes[0]);
  }

  const signature = getUnionSignature(mergedProperties);
  const cached = this.anonUnionCache.get(signature);
  if (cached) return cached;

  const symbol = new InterfaceTypeSymbol(
    `__anon_union_${++this.anonUnionCounter}`,
    new Map(),
    mergedProperties,
  );
  this.anonUnionCache.set(signature, symbol);
  // Also register the synthetic symbol under its own name so downstream
  // consumers (e.g. D-3 dispatch's structural-compatibility lookup via
  // typeMapper.getAlias) can resolve it directly by its TypeSymbol.name.
  // Without this, only the user-facing alias name (e.g. "Result") points
  // at the symbol, leaving `__anon_union_N` unresolvable.
  this.typeMapper.registerTypeAlias(symbol.name, symbol);
  return symbol;
}

export function mapTypeWithGenerics(
  this: TypeScriptParser,
  typeText: string,
  node?: ts.Node,
): TypeSymbol {
  // TypeChecker-first resolution when we have the original ts.Node
  if (node && this.checkerTypeResolver) {
    try {
      const resolved = this.checkerTypeResolver.resolveFromTsNode(node);
      if (resolved && resolved !== ObjectType) {
        return resolved;
      }
    } catch (e) {
      if (e instanceof TranspileError && !typeText.trim().startsWith("__")) {
        throw e;
      }
      // Fall through to legacy text-based path
    }
  }

  const trimmed = typeText.trim();
  const genericParam = this.resolveGenericParam(trimmed);
  if (genericParam) return genericParam;

  if (node && ts.isTypePredicateNode(node)) {
    return PrimitiveTypes.boolean;
  }

  if (node && ts.isIntersectionTypeNode(node)) {
    const branded = tryResolveBrandedPrimitive(node);
    if (branded) return branded;
    return ObjectType;
  }

  if (
    node &&
    (ts.isTypeQueryNode(node) ||
      ts.isIndexedAccessTypeNode(node) ||
      ts.isConditionalTypeNode(node) ||
      ts.isMappedTypeNode(node))
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
    let hasUnsupportedMember = false;
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.name) {
        hasUnsupportedMember = true;
        break;
      }
      const nameInfo = getTypeLiteralPropertyName(member.name);
      if (!nameInfo || !isInlineSafePropertyName(nameInfo.propName)) {
        hasUnsupportedMember = true;
        break;
      }
      const propType = member.type
        ? this.mapTypeWithGenerics(member.type.getText(), member.type)
        : ObjectType;
      propertyMap.set(nameInfo.propName, propType);
    }
    if (!hasUnsupportedMember && propertyMap.size > 0) {
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
    const structuralUnion = this.resolveStructuralUnionType(node);
    if (structuralUnion) return structuralUnion;
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

  const finalMapped = this.typeMapper.tryMapTypeScriptType(trimmed);
  if (finalMapped !== null) return finalMapped;
  const loc = node
    ? this.createLoc(node)
    : { filePath: "<unknown>", line: 0, column: 0 };
  throw new TranspileError(
    "TypeError",
    `Unknown TypeScript type "${trimmed}"`,
    loc,
  );
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
  // TypeChecker-first resolution when available
  if (this.checkerTypeResolver) {
    try {
      const resolved = this.checkerTypeResolver.resolveFromTsNode(node);
      if (resolved && resolved !== ObjectType) {
        return resolved;
      }
    } catch (e) {
      if (
        e instanceof TranspileError &&
        !(ts.isIdentifier(node) && node.text.startsWith("__"))
      ) {
        throw e;
      }
      // Fall through to legacy inference path
    }
  }

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
    case ts.SyntaxKind.CallExpression:
      return ObjectType;
    case ts.SyntaxKind.NewExpression: {
      const newExpr = node as ts.NewExpression;
      if (this.checkerTypeResolver) {
        try {
          const resolved = this.checkerTypeResolver.resolveFromTsNode(newExpr);
          if (resolved && resolved !== ObjectType) return resolved;
        } catch {
          // Fall through to legacy resolution
        }
      }
      if (ts.isIdentifier(newExpr.expression)) {
        const baseName = newExpr.expression.text;
        if (newExpr.typeArguments && newExpr.typeArguments.length > 0) {
          const typeArgs = newExpr.typeArguments.map((a) =>
            this.mapTypeWithGenerics(a.getText(), a),
          );
          if (baseName === "Array" || baseName === "ReadonlyArray") {
            return new ArrayTypeSymbol(typeArgs[0] ?? ObjectType);
          }
          if (baseName === "UdonDictionary" || baseName === "Dictionary") {
            return new CollectionTypeSymbol(
              baseName,
              undefined,
              typeArgs[0] ?? ObjectType,
              typeArgs[1] ?? ObjectType,
            );
          }
          return new CollectionTypeSymbol(baseName, typeArgs[0] ?? ObjectType);
        }
        return this.mapTypeWithGenerics(baseName);
      }
      return ObjectType;
    }
    case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return this.typeMapper.mapTypeScriptType("string");
    case ts.SyntaxKind.ParenthesizedExpression:
      return this.inferType((node as ts.ParenthesizedExpression).expression);
    case ts.SyntaxKind.ConditionalExpression: {
      const cond = node as ts.ConditionalExpression;
      const trueType = this.inferType(cond.whenTrue);
      const falseType = this.inferType(cond.whenFalse);
      if (
        trueType.name === falseType.name &&
        trueType.udonType === falseType.udonType
      ) {
        return trueType;
      }
      if (trueType === ObjectType) return falseType;
      if (falseType === ObjectType) return trueType;
      return ObjectType;
    }
    case ts.SyntaxKind.PrefixUnaryExpression: {
      const pue = node as ts.PrefixUnaryExpression;
      if (pue.operator === ts.SyntaxKind.ExclamationToken) {
        return this.typeMapper.mapTypeScriptType("boolean");
      }
      return this.typeMapper.mapTypeScriptType("number");
    }
    case ts.SyntaxKind.ArrayLiteralExpression: {
      const arr = node as ts.ArrayLiteralExpression;
      let commonType: TypeSymbol | null = null;
      for (const elem of arr.elements) {
        if (ts.isSpreadElement(elem)) return new ArrayTypeSymbol(ObjectType);
        const elemType = this.inferType(elem);
        if (elemType === ObjectType) return new ArrayTypeSymbol(ObjectType);
        if (commonType === null) {
          commonType = elemType;
        } else if (
          commonType.name !== elemType.name ||
          commonType.udonType !== elemType.udonType
        ) {
          return new ArrayTypeSymbol(ObjectType);
        }
      }
      return new ArrayTypeSymbol(commonType ?? ObjectType);
    }
    default:
      return ObjectType;
  }
}

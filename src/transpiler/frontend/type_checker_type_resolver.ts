import * as ts from "typescript";
import type { TypeCheckerContext } from "./type_checker_context.js";
import type { TypeMapper } from "./type_mapper.js";
import {
  ArrayTypeSymbol,
  ClassTypeSymbol,
  GenericTypeParameterSymbol,
  InterfaceTypeSymbol,
  ObjectType,
  PrimitiveTypes,
  type TypeSymbol,
  UDON_BRANDED_TYPE_MAP,
} from "./type_symbols.js";
import type { ASTNode } from "./types.js";
import { UdonType } from "./types.js";

const TYPE_TO_STRING_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

function stripModuleQualifier(name: string): string {
  return name.replace(/^".*"\./, "");
}

/**
 * Resolves TypeScript compiler types (ts.Type / ts.Node) to internal TypeSymbols.
 *
 * This is the canonical bridge between TypeScript's type system and the
 * transpiler's Udon-oriented type model.  All conversions go through here so
 * that parser + IR can share one source of truth.
 */
export class TypeCheckerTypeResolver {
  private readonly typeCache = new Map<ts.Type, TypeSymbol>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly typeMapper: TypeMapper,
  ) {}

  /** Resolve from a custom AST node that was previously bridged to a ts.Node. */
  resolveFromAstNode(
    node: ASTNode,
    checkerContext: TypeCheckerContext,
  ): TypeSymbol | null {
    const tsNode = checkerContext.resolveTsNode(node);
    if (!tsNode) return null;
    return this.resolveFromTsNode(tsNode);
  }

  /** Resolve directly from a TypeScript AST node. */
  resolveFromTsNode(node: ts.Node): TypeSymbol {
    const type = this.checker.getTypeAtLocation(node);
    return this.resolveFromTsType(type);
  }

  /** Resolve from a ts.Type, with cycle protection via caching. */
  resolveFromTsType(type: ts.Type): TypeSymbol {
    const cached = this.typeCache.get(type);
    if (cached) return cached;
    // Insert a sentinel so any re-entrant call (e.g. recursive type alias)
    // returns ObjectType instead of recursing infinitely.
    this.typeCache.set(type, ObjectType);
    try {
      const result = this.resolveFromTsTypeUncached(type);
      this.typeCache.set(type, result);
      return result;
    } catch (e) {
      this.typeCache.delete(type);
      throw e;
    }
  }

  private resolveFromTsTypeUncached(type: ts.Type): TypeSymbol {
    // 1. Strip null/undefined from unions first (string | null → string)
    const nonNullish = this.removeNullishUnionMembers(type);
    if (nonNullish) {
      return this.resolveFromTsType(nonNullish);
    }

    // 1b. Enum literals and enum types — resolve before literal collapse
    const enumSymbol = type.getSymbol() ?? type.aliasSymbol;
    if (enumSymbol && enumSymbol.flags & ts.SymbolFlags.Enum) {
      const typeName = stripModuleQualifier(
        this.checker.getFullyQualifiedName(enumSymbol),
      );
      const mapped = this.typeMapper.mapTypeScriptType(typeName);
      if (!(mapped instanceof ClassTypeSymbol)) return mapped;
      // Unregistered enum mis-classified as class — fall through.
    }
    if (type.flags & ts.TypeFlags.EnumLiteral) {
      const declaration = enumSymbol?.declarations?.[0];
      if (declaration) {
        const parentDecl = declaration.parent as ts.Node;
        const parentSymbol = this.checker.getSymbolAtLocation(parentDecl);
        if (parentSymbol) {
          const parentName = stripModuleQualifier(
            this.checker.getFullyQualifiedName(parentSymbol),
          );
          const mapped = this.typeMapper.mapTypeScriptType(parentName);
          if (!(mapped instanceof ClassTypeSymbol)) return mapped;
          // Unregistered parent enum mis-classified as class — fall through.
        }
      }
    }

    // 2. Literal types (string literal, number literal, bigint literal)
    // Note: type.isLiteral() is true for StringLiteral, NumberLiteral,
    // BigIntLiteral. Boolean literal types have TypeFlags.BooleanLike
    // and are handled in step 4.
    if (type.isLiteral()) {
      if (type.flags & ts.TypeFlags.BigIntLiteral) return PrimitiveTypes.int64;
      if (typeof type.value === "string") return PrimitiveTypes.string;
      if (typeof type.value === "number") return PrimitiveTypes.single;
      return PrimitiveTypes.single;
    }

    // 3. Array / Tuple
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) {
      const ref = type as ts.TypeReference;
      const args = this.checker.getTypeArguments(ref);
      if (args.length === 0) {
        return new ArrayTypeSymbol(ObjectType, 1);
      }
      const resolvedArgs = args.map((a) => this.resolveFromTsType(a));
      const first = resolvedArgs[0];
      const allSame = resolvedArgs.every((r) => r === first);
      const elementType = allSame ? first : ObjectType;
      return new ArrayTypeSymbol(elementType, 1);
    }

    // 4. Primitive flags
    if (type.flags & ts.TypeFlags.BooleanLike) return PrimitiveTypes.boolean;
    if (type.flags & ts.TypeFlags.NumberLike) return PrimitiveTypes.single;
    if (type.flags & ts.TypeFlags.StringLike) return PrimitiveTypes.string;
    if (type.flags & ts.TypeFlags.BigIntLike) return PrimitiveTypes.int64;
    if (type.flags & ts.TypeFlags.Void) return PrimitiveTypes.void;

    // 5. Union (remaining after nullish strip — e.g. string | number)
    if (type.flags & ts.TypeFlags.Union) {
      const union = type as ts.UnionType;
      // If every member resolves to the same TypeSymbol, return it.
      // Otherwise fall through to symbol-based or text-based resolution.
      const memberTypes = union.types.map((t) => this.resolveFromTsType(t));
      if (
        memberTypes.length > 0 &&
        memberTypes.every((t) => t === memberTypes[0])
      ) {
        return memberTypes[0];
      }
      // String-literal unions → string
      if (union.types.every((t) => t.flags & ts.TypeFlags.StringLike)) {
        return PrimitiveTypes.string;
      }
      // Boolean-literal unions → boolean
      if (union.types.every((t) => t.flags & ts.TypeFlags.BooleanLike)) {
        return PrimitiveTypes.boolean;
      }
    }

    // 6. Intersection (branded primitives, e.g. UdonInt & { __brand: "UdonInt" })
    if (type.flags & ts.TypeFlags.Intersection) {
      const intersection = type as ts.IntersectionType;
      const branded = this.tryResolveBrandedPrimitive(intersection);
      if (branded) return branded;
    }

    // 7. Symbol-backed types (classes, interfaces, type aliases, enums)
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    if (symbol) {
      const symFlags = symbol.flags;

      // 7a. Type parameter → GenericTypeParameterSymbol
      if (symFlags & ts.SymbolFlags.TypeParameter) {
        const name = this.checker.symbolToString(symbol);
        return new GenericTypeParameterSymbol(name);
      }

      // 7b. Enum → resolve via enum kind
      if (symFlags & ts.SymbolFlags.Enum) {
        const typeName = stripModuleQualifier(
          this.checker.getFullyQualifiedName(symbol),
        );
        const mapped = this.typeMapper.mapTypeScriptType(typeName);
        // Guard: an unregistered PascalCase enum name is mis-classified as a
        // ClassTypeSymbol by mapTypeScriptType. Only accept the mapping when
        // it is not a generic ClassTypeSymbol.
        if (!(mapped instanceof ClassTypeSymbol)) return mapped;
        // Unknown enum — return ObjectType rather than a bogus class type.
        return ObjectType;
      }

      // 7c. Interface → build InterfaceTypeSymbol from declared members
      if (symFlags & ts.SymbolFlags.Interface) {
        const iface = this.buildInterfaceTypeSymbol(type, symbol);
        if (iface) return iface;
      }

      // 7d. Class → typeMapper lookup; let TranspileError propagate for
      // unknown declared types rather than silently falling back.
      if (symFlags & ts.SymbolFlags.Class) {
        const className = stripModuleQualifier(
          this.checker.getFullyQualifiedName(symbol),
        );
        const mapped = this.typeMapper.mapTypeScriptType(className);
        if (mapped !== ObjectType) return mapped;
        return new ClassTypeSymbol(className, UdonType.Object);
      }

      // 7e. Type alias → resolve the alias type
      if (symFlags & ts.SymbolFlags.TypeAlias) {
        const aliasType = this.checker.getDeclaredTypeOfSymbol(symbol);
        if (aliasType && aliasType !== type) {
          return this.resolveFromTsType(aliasType);
        }
      }

      // 7f. Fully-qualified name fallback
      const fullyQualified = stripModuleQualifier(
        this.checker.getFullyQualifiedName(symbol),
      );
      if (fullyQualified.length > 0) {
        // Simple identifiers (e.g. "Foo", "Foo.Bar") should propagate errors
        // so unknown declared types fail fast. Complex/anonymous type texts
        // are allowed to fall back to ObjectType.
        const isSimpleIdentifier =
          /^(?:\p{ID_Start}|[$_])(?:\p{ID_Continue}|[$_\u200C\u200D])*(?:\.(?:\p{ID_Start}|[$_])(?:\p{ID_Continue}|[$_\u200C\u200D])*)*$/u.test(
            fullyQualified,
          );
        if (isSimpleIdentifier) {
          const mapped = this.typeMapper.mapTypeScriptType(fullyQualified);
          if (mapped !== ObjectType) return mapped;
        } else {
          try {
            const mapped = this.typeMapper.mapTypeScriptType(fullyQualified);
            if (mapped !== ObjectType) return mapped;
          } catch {
            // Unknown complex type — fall through to step 10
          }
        }
      }
    }

    // 8. Anonymous object / mapped / conditional / indexed access → try to build interface
    if (type.flags & ts.TypeFlags.Object) {
      const objType = type as ts.ObjectType;
      // Anonymous type with properties
      if (objType.objectFlags & ts.ObjectFlags.Anonymous) {
        const props = this.checker.getPropertiesOfType(type);
        if (props.length > 0) {
          const propertyMap = new Map<string, TypeSymbol>();
          const methodMap = new Map<
            string,
            { params: TypeSymbol[]; returnType: TypeSymbol }
          >();
          this.populateMemberMaps(props, propertyMap, methodMap);
          const methodEntries = [...methodMap.entries()].map(([name, sig]) => {
            const paramTypes = sig.params.map((p) => p.name).join(",");
            return `${name}(${paramTypes}):${sig.returnType.name}`;
          });
          const propEntries = [...propertyMap.entries()].map(
            ([name, type]) => `${name}:${type.name}`,
          );
          const anonKey = [...propEntries, ...methodEntries].sort().join("|");
          return new InterfaceTypeSymbol(
            `__anon_${anonKey}`,
            methodMap,
            propertyMap,
          );
        }
      }
      // Mapped type → ObjectType (Udon doesn't support mapped types natively)
      if (objType.objectFlags & ts.ObjectFlags.Mapped) {
        return ObjectType;
      }
    }

    // 9. Type reference with type arguments (e.g. Array<T>, Map<K,V>)
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const paramSymbol = type.getSymbol();
      if (paramSymbol) {
        return new GenericTypeParameterSymbol(
          this.checker.symbolToString(paramSymbol),
        );
      }
    }

    // 10. Fallback to type-to-string + typeMapper
    const typeText = this.checker.typeToString(
      type,
      undefined,
      TYPE_TO_STRING_FLAGS,
    );
    try {
      return this.typeMapper.mapTypeScriptType(typeText);
    } catch {
      return ObjectType;
    }
  }

  /** Build an InterfaceTypeSymbol from an interface type. */
  private buildInterfaceTypeSymbol(
    type: ts.Type,
    symbol: ts.Symbol,
  ): InterfaceTypeSymbol | null {
    const props = this.checker.getPropertiesOfType(type);
    if (props.length === 0) return null;

    const propertyMap = new Map<string, TypeSymbol>();
    const methodMap = new Map<
      string,
      { params: TypeSymbol[]; returnType: TypeSymbol }
    >();

    this.populateMemberMaps(props, propertyMap, methodMap);

    const name = stripModuleQualifier(
      this.checker.getFullyQualifiedName(symbol),
    );
    return new InterfaceTypeSymbol(name, methodMap, propertyMap);
  }

  private removeNullishUnionMembers(type: ts.Type): ts.Type | null {
    if (!(type.flags & ts.TypeFlags.Union)) return null;
    const union = type as ts.UnionType;
    const filtered = union.types.filter(
      (member) => !this.isNullishType(member),
    );
    if (filtered.length !== 1) return null;
    return filtered[0];
  }

  private isNullishType(type: ts.Type): boolean {
    return (
      (type.flags & ts.TypeFlags.Null) !== 0 ||
      (type.flags & ts.TypeFlags.Undefined) !== 0
    );
  }

  private tryResolveBrandedPrimitive(
    intersection: ts.IntersectionType,
  ): TypeSymbol | null {
    for (const constituent of intersection.types) {
      const symbol = constituent.getSymbol();
      if (!symbol) continue;
      const name = this.checker.symbolToString(symbol);
      const mapped = UDON_BRANDED_TYPE_MAP.get(name);
      if (mapped) return mapped;
    }
    // Also try type text on each constituent
    for (const constituent of intersection.types) {
      const text = this.checker.typeToString(
        constituent,
        undefined,
        TYPE_TO_STRING_FLAGS,
      );
      const mapped = UDON_BRANDED_TYPE_MAP.get(text);
      if (mapped) return mapped;
    }
    return null;
  }

  /** Resolve symbols into propertyMap / methodMap. Used by both anonymous-object
   *  and interface paths to avoid drift. */
  private populateMemberMaps(
    props: ts.Symbol[],
    propertyMap: Map<string, TypeSymbol>,
    methodMap: Map<string, { params: TypeSymbol[]; returnType: TypeSymbol }>,
  ): void {
    for (const prop of props) {
      const propDecl = prop.valueDeclaration ?? prop.declarations?.[0];
      const propType = propDecl
        ? this.checker.getTypeOfSymbolAtLocation(prop, propDecl)
        : this.checker.getDeclaredTypeOfSymbol(prop);

      if (prop.flags & ts.SymbolFlags.Method) {
        const sigs = this.checker.getSignaturesOfType(
          propType,
          ts.SignatureKind.Call,
        );
        if (sigs.length > 0) {
          const sig = sigs[0];
          const params = sig.parameters.map((p) => {
            const pDecl = p.valueDeclaration ?? p.declarations?.[0];
            const pType = pDecl
              ? this.checker.getTypeOfSymbolAtLocation(p, pDecl)
              : this.checker.getDeclaredTypeOfSymbol(p);
            return this.resolveFromTsType(pType);
          });
          const retType = this.resolveFromTsType(sig.getReturnType());
          methodMap.set(prop.name, { params, returnType: retType });
          continue;
        }
      }

      propertyMap.set(prop.name, this.resolveFromTsType(propType));
    }
  }
}

export function createTypeCheckerTypeResolver(
  checkerContext: TypeCheckerContext,
  typeMapper: TypeMapper,
): TypeCheckerTypeResolver {
  return new TypeCheckerTypeResolver(
    checkerContext.getTypeChecker(),
    typeMapper,
  );
}

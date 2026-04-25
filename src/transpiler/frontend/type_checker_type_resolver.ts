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
  // `getFullyQualifiedName` walks symbol chains and calls
  // `createExpressionFromSymbolChain` / `symbolToStringWorker` internally —
  // measured ~140ms of TS-internal work on mahjong-t2. The result is
  // deterministic per ts.Symbol within a single program, so memoize.
  private readonly fqNameCache = new WeakMap<ts.Symbol, string>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly typeMapper: TypeMapper,
  ) {}

  private fqName(symbol: ts.Symbol): string {
    const cached = this.fqNameCache.get(symbol);
    if (cached !== undefined) return cached;
    const result = this.checker.getFullyQualifiedName(symbol);
    this.fqNameCache.set(symbol, result);
    return result;
  }

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
    let result: TypeSymbol;
    try {
      result = this.resolveFromTsTypeUncached(type);
    } catch (e) {
      // Clear sentinel on TranspileError so re-entry re-throws the hard
      // error instead of silently returning ObjectType.
      this.typeCache.delete(type);
      throw e;
    }
    this.typeCache.set(type, result);
    return result;
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
        this.fqName(enumSymbol),
      );
      const mapped =
        this.typeMapper.tryMapTypeScriptType(typeName) ??
        new ClassTypeSymbol(typeName, UdonType.Object);
      if (!(mapped instanceof ClassTypeSymbol)) return mapped;
      return this.resolveEnumFallback(enumSymbol);
    }
    if (type.flags & ts.TypeFlags.EnumLiteral) {
      const parentSymbol =
        (enumSymbol as unknown as { parent?: ts.Symbol }).parent ??
        (() => {
          const decl = enumSymbol?.declarations?.[0] as
            | ts.EnumMember
            | undefined;
          return decl && ts.isEnumMember(decl)
            ? this.checker.getSymbolAtLocation(decl.parent.name)
            : undefined;
        })();
      if (parentSymbol) {
        const parentName = stripModuleQualifier(
          this.fqName(parentSymbol),
        );
        const mapped =
          this.typeMapper.tryMapTypeScriptType(parentName) ??
          new ClassTypeSymbol(parentName, UdonType.Object);
        if (!(mapped instanceof ClassTypeSymbol)) return mapped;
        return this.resolveEnumFallback(parentSymbol);
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
      if (elementType instanceof ArrayTypeSymbol) {
        return new ArrayTypeSymbol(
          elementType.elementType,
          elementType.dimensions + 1,
        );
      }
      return new ArrayTypeSymbol(elementType, 1);
    }

    // 4. Primitive flags
    if (type.flags & ts.TypeFlags.BooleanLike) return PrimitiveTypes.boolean;
    if (type.flags & ts.TypeFlags.NumberLike) return PrimitiveTypes.single;
    if (type.flags & ts.TypeFlags.StringLike) return PrimitiveTypes.string;
    if (type.flags & ts.TypeFlags.BigIntLike) return PrimitiveTypes.int64;
    if (type.flags & ts.TypeFlags.Void) return PrimitiveTypes.void;

    // 4b. Null / Undefined — Udon doesn't have nullable types natively
    if (this.isNullishType(type)) return ObjectType;

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

      // 7b-c. Interface → build InterfaceTypeSymbol from declared members
      if (symFlags & ts.SymbolFlags.Interface) {
        return this.buildInterfaceTypeSymbol(type, symbol);
      }

      // 7d. Class → typeMapper lookup; let TranspileError propagate for
      // unknown declared types rather than silently falling back.
      if (symFlags & ts.SymbolFlags.Class) {
        const className = stripModuleQualifier(
          this.fqName(symbol),
        );
        const mapped = this.typeMapper.mapTypeScriptType(className);
        if (mapped !== ObjectType) return mapped;
        return new ClassTypeSymbol(className, UdonType.Object);
      }

      // 7e. Type alias → resolve the alias type, overlaying the alias name
      // if the recursion returned an anonymous InterfaceTypeSymbol.
      //
      // TypeScript's `getDeclaredTypeOfSymbol(alias)` often returns a ts.Type
      // whose `aliasSymbol` is NOT set — so when the recursion lands in step 8
      // below, that step cannot recover the alias name from `type.aliasSymbol`.
      // Overlaying the alias name here preserves the canonical identity across
      // both the text-based resolution path and the TS-checker path. Without
      // this, cross-module uses of type-aliased interfaces (e.g. mahjong's
      // `export type IYaku = {...}` flowing into `map.set` parameter slots)
      // emit `__anon_<digest>` names that do not match `interfaceClassIdMap`,
      // which keys on the canonical alias name — causing the inline-handle
      // wrap path to miss and a DataToken(Object) ctor to be selected instead
      // of the correct DataToken(Int32) ctor.
      if (symFlags & ts.SymbolFlags.TypeAlias) {
        const aliasType = this.checker.getDeclaredTypeOfSymbol(symbol);
        if (aliasType && aliasType !== type) {
          const resolved = this.resolveFromTsType(aliasType);
          if (
            resolved instanceof InterfaceTypeSymbol &&
            resolved.name.startsWith("__anon_")
          ) {
            const aliasName = stripModuleQualifier(
              this.fqName(symbol),
            );
            if (aliasName.length > 0 && !aliasName.startsWith("__anon_")) {
              return new InterfaceTypeSymbol(
                aliasName,
                resolved.methods,
                resolved.properties,
              );
            }
          }
          return resolved;
        }
      }

      // 7f. Fully-qualified name fallback
      const fullyQualified = stripModuleQualifier(
        this.fqName(symbol),
      );
      if (fullyQualified.length > 0) {
        const mapped = this.typeMapper.tryMapTypeScriptType(fullyQualified);
        if (mapped !== null && mapped !== ObjectType) return mapped;
        // null or ObjectType — fall through to step 10
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
          // If TypeScript tracks an alias symbol for this anonymous type
          // (e.g. a type-argument substitution that retained its alias link),
          // use the canonical alias name instead of the structural digest.
          // Symmetric with step 7e's overlay; covers entries that bypass 7e.
          if (type.aliasSymbol) {
            const aliasName = stripModuleQualifier(
              this.fqName(type.aliasSymbol),
            );
            if (aliasName.length > 0 && !aliasName.startsWith("__anon_")) {
              return new InterfaceTypeSymbol(aliasName, methodMap, propertyMap);
            }
          }
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
    const mapped = this.typeMapper.tryMapTypeScriptType(typeText);
    if (mapped !== null) return mapped;
    const trimmed = typeText.trim();
    const isSimpleName =
        /^(?:\p{ID_Start}|[$_])(?:\p{ID_Continue}|[$_\u200C\u200D])*(?:\.(?:\p{ID_Start}|[$_])(?:\p{ID_Continue}|[$_\u200C\u200D])*)*$/u.test(
          trimmed,
        ) && !trimmed.startsWith("__");
    if (isSimpleName) {
      // Hard error: simple-name type that cannot be mapped is likely a
      // missing extern. Surface to the user via mapTypeScriptType's throw.
      return this.typeMapper.mapTypeScriptType(typeText);
    }
    return ObjectType;
  }

  /** Build an InterfaceTypeSymbol from an interface type. */
  private buildInterfaceTypeSymbol(
    type: ts.Type,
    symbol: ts.Symbol,
  ): InterfaceTypeSymbol {
    const propertyMap = new Map<string, TypeSymbol>();
    const methodMap = new Map<
      string,
      { params: TypeSymbol[]; returnType: TypeSymbol }
    >();

    const props = this.checker.getPropertiesOfType(type);
    if (props.length > 0) {
      this.populateMemberMaps(props, propertyMap, methodMap);
    }

    const name = stripModuleQualifier(
      this.fqName(symbol),
    );
    return new InterfaceTypeSymbol(name, methodMap, propertyMap);
  }

  private removeNullishUnionMembers(type: ts.Type): ts.Type | null {
    if (!(type.flags & ts.TypeFlags.Union)) return null;
    const union = type as ts.UnionType;
    const filtered = union.types.filter(
      (member) => !this.isNullishType(member),
    );
    if (filtered.length === 0) return null;
    if (filtered.length === 1) return filtered[0];
    // Multiple survivors — if they all resolve to the same TypeSymbol,
    // return a representative ts.Type so the caller can resolve it.
    const resolved = filtered.map((t) => this.resolveFromTsType(t));
    if (resolved.every((r) => r === resolved[0])) {
      return filtered[0];
    }
    return null;
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

  /**
   * Fallback for unregistered enums: inspect the enum declaration's members
   * and infer string, int32, or ObjectType based on initializer types.
   */
  private resolveEnumFallback(enumSymbol: ts.Symbol): TypeSymbol {
    const decl = enumSymbol.declarations?.[0] as ts.EnumDeclaration | undefined;
    if (!decl) return ObjectType;
    let allString = true;
    let allNumber = true;
    for (const member of decl.members) {
      if (member.initializer) {
        if (ts.isStringLiteral(member.initializer)) {
          allNumber = false;
        } else if (
          ts.isNumericLiteral(member.initializer) ||
          (ts.isPrefixUnaryExpression(member.initializer) &&
            (member.initializer.operator === ts.SyntaxKind.MinusToken ||
              member.initializer.operator === ts.SyntaxKind.PlusToken) &&
            ts.isNumericLiteral(member.initializer.operand))
        ) {
          allString = false;
        } else {
          allString = false;
          allNumber = false;
        }
      } else {
        // No initializer implies auto-increment numeric
        allString = false;
      }
    }
    if (decl.members.length === 0) return ObjectType;
    if (allString) return PrimitiveTypes.string;
    if (allNumber) return PrimitiveTypes.int32;
    return ObjectType;
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

      // Detect callable properties (method symbols or function-typed fields)
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

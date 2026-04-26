import { TranspileError } from "../errors/transpile_errors.js";
import type { EnumRegistry } from "./enum_registry.js";
import {
  ArrayTypeSymbol,
  ClassTypeSymbol,
  CollectionTypeSymbol,
  ExternTypes,
  GenericTypeParameterSymbol,
  NativeArrayTypeSymbol,
  ObjectType,
  PrimitiveTypes,
  type TypeSymbol,
  UDON_BRANDED_TYPE_MAP,
} from "./type_symbols.js";
import { UdonType } from "./types.js";

// Matches two or more quoted string literals joined by "|",
// e.g. "'a' | \"b\"" or "\"foo\" | 'bar'". Does not match bare identifiers.
const STRING_LITERAL_UNION_RE =
  /^("[^"]*"|'[^']*')(\s*\|\s*("[^"]*"|'[^']*'))+$/;

/**
 * Canonical lookup of TypeScript / C# builtin type names that have a single
 * unambiguous Udon TypeSymbol counterpart. Both `lookupBuiltinByName` and the
 * simple-name branch of `mapTypeScriptTypeImpl` consult this map so the
 * mapping cannot drift between the resolver path and the legacy text path.
 *
 * Entries that need parameterised construction (Set/Map/ReadonlySet/
 * ReadonlyMap → CollectionTypeSymbol with key/value slots) are intentionally
 * kept out of this table; those still live as explicit cases in
 * `mapTypeScriptTypeImpl`.
 */
const BUILTIN_NAME_MAP: ReadonlyMap<string, TypeSymbol> = new Map<
  string,
  TypeSymbol
>([
  ...UDON_BRANDED_TYPE_MAP,
  ["number", PrimitiveTypes.single],
  ["float", PrimitiveTypes.single],
  ["boolean", PrimitiveTypes.boolean],
  ["bool", PrimitiveTypes.boolean],
  ["string", PrimitiveTypes.string],
  ["object", ExternTypes.dataDictionary],
  ["void", PrimitiveTypes.void],
  ["int", PrimitiveTypes.int32],
  ["short", PrimitiveTypes.int16],
  ["ushort", PrimitiveTypes.uint16],
  ["uint", PrimitiveTypes.uint32],
  ["long", PrimitiveTypes.int64],
  ["ulong", PrimitiveTypes.uint64],
  ["byte", PrimitiveTypes.byte],
  ["sbyte", PrimitiveTypes.sbyte],
  ["double", PrimitiveTypes.double],
  ["bigint", PrimitiveTypes.int64],
  ["unknown", ObjectType],
  ["never", ObjectType],
  ["any", ObjectType],
  ["Vector2", ExternTypes.vector2],
  ["UnityEngine.Vector2", ExternTypes.vector2],
  ["Vector3", ExternTypes.vector3],
  ["UnityEngine.Vector3", ExternTypes.vector3],
  ["Vector4", ExternTypes.vector4],
  ["UnityEngine.Vector4", ExternTypes.vector4],
  ["Quaternion", ExternTypes.quaternion],
  ["UnityEngine.Quaternion", ExternTypes.quaternion],
  ["Color", ExternTypes.color],
  ["UnityEngine.Color", ExternTypes.color],
  ["Transform", ExternTypes.transform],
  ["UnityEngine.Transform", ExternTypes.transform],
  ["GameObject", ExternTypes.gameObject],
  ["UnityEngine.GameObject", ExternTypes.gameObject],
  ["AudioSource", ExternTypes.audioSource],
  ["UnityEngine.AudioSource", ExternTypes.audioSource],
  ["AudioClip", ExternTypes.audioClip],
  ["UnityEngine.AudioClip", ExternTypes.audioClip],
  ["Animator", ExternTypes.animator],
  ["UnityEngine.Animator", ExternTypes.animator],
  ["Component", ExternTypes.component],
  ["UnityEngine.Component", ExternTypes.component],
  ["VRCPlayerApi", ExternTypes.vrcPlayerApi],
  ["VRC.SDKBase.VRCPlayerApi", ExternTypes.vrcPlayerApi],
  ["UdonBehaviour", ExternTypes.udonBehaviour],
  ["VRC.Udon.UdonBehaviour", ExternTypes.udonBehaviour],
  ["DataList", ExternTypes.dataList],
  ["VRC.SDK3.Data.DataList", ExternTypes.dataList],
  ["DataDictionary", ExternTypes.dataDictionary],
  ["VRC.SDK3.Data.DataDictionary", ExternTypes.dataDictionary],
  ["DataToken", ExternTypes.dataToken],
  ["VRC.SDK3.Data.DataToken", ExternTypes.dataToken],
  ["Type", ExternTypes.systemType],
  ["System.Type", ExternTypes.systemType],
]);

export class TypeMapper {
  private typeAliases = new Map<string, TypeSymbol>();
  // Stores both successful (TypeSymbol) and unmappable (null) results.
  // Use `has()` to distinguish "not yet probed" from "probed and null" so
  // hot speculative paths (e.g. resolver step 7f's fully-qualified-name
  // fallback) skip the full mapTypeScriptTypeImpl re-walk on repeat misses.
  private typeCache = new Map<string, TypeSymbol | null>();
  private unionAliases = new Map<string, TypeSymbol[]>();

  constructor(private enumRegistry?: EnumRegistry) {}

  getAlias(name: string): TypeSymbol | undefined {
    return this.typeAliases.get(name);
  }

  registerTypeAlias(name: string, symbol: TypeSymbol): void {
    this.typeAliases.set(name, symbol);
    this.typeCache.clear();
  }

  registerUnionAlias(name: string, parts: TypeSymbol[]): void {
    this.unionAliases.set(name, parts);
  }

  getUnionParts(name: string): TypeSymbol[] | undefined {
    return this.unionAliases.get(name);
  }

  mapTypeScriptType(tsType: string): TypeSymbol {
    const result = this.tryMapTypeScriptType(tsType);
    if (result !== null) return result;
    throw new TranspileError(
      "TypeError",
      `Unknown TypeScript type "${tsType.trim()}"`,
      { filePath: "<unknown>", line: 0, column: 0 },
    );
  }

  /**
   * Non-throwing variant of {@link mapTypeScriptType}: returns `null` for
   * unmappable types instead of throwing a `TranspileError`. Use this when
   * the call is speculative and the caller falls back to another path.
   * Avoids `Error.captureStackTrace` cost on every miss in hot paths.
   */
  tryMapTypeScriptType(tsType: string): TypeSymbol | null {
    const trimmed = tsType.trim();
    // Enum check runs before cache: enumRegistry may gain entries after a
    // previous call cached a fallback result for the same type name.
    if (this.enumRegistry?.isEnum(trimmed)) {
      const kind = this.enumRegistry.getEnumKind(trimmed);
      const result =
        kind === "string" ? PrimitiveTypes.string : PrimitiveTypes.int32;
      const existing = this.typeCache.get(trimmed);
      if (existing !== undefined && existing !== result) {
        // Enum kind changed after a previous fallback was cached — clear
        // composites (e.g. Foo[], Array<Foo>) that embedded the old value.
        this.typeCache.clear();
      }
      this.typeCache.set(trimmed, result);
      return result;
    }
    if (this.typeCache.has(trimmed)) {
      // Returns either the cached TypeSymbol or the cached null sentinel.
      return this.typeCache.get(trimmed) ?? null;
    }
    const result = this.mapTypeScriptTypeImpl(trimmed);
    this.typeCache.set(trimmed, result);
    return result;
  }

  private mapTypeScriptTypeImpl(trimmed: string): TypeSymbol | null {
    if (trimmed.startsWith("readonly ")) {
      return this.tryMapTypeScriptType(trimmed.slice(9));
    }
    if (trimmed.startsWith("asserts ")) {
      return PrimitiveTypes.void;
    }
    if (/^\w+\s+is\s+\S/.test(trimmed)) {
      return PrimitiveTypes.boolean;
    }
    const alias = this.typeAliases.get(trimmed);
    if (alias) return alias;

    const genericParamName = this.normalizeGenericTypeParameterName(trimmed);
    if (genericParamName) {
      return new GenericTypeParameterSymbol(genericParamName);
    }

    if (this.isStringLiteralUnionType(trimmed)) {
      return PrimitiveTypes.string;
    }

    if (trimmed === "true" || trimmed === "false") {
      return PrimitiveTypes.boolean;
    }

    if (/^"[^"]*"$/.test(trimmed) || /^'[^']*'$/.test(trimmed)) {
      return PrimitiveTypes.string;
    }

    if (trimmed.includes(" | ")) {
      const parts = trimmed
        .split("|")
        .map((part) => part.trim())
        .filter((part) => part !== "null" && part !== "undefined");
      if (parts.length === 1) {
        return this.tryMapTypeScriptType(parts[0]);
      }
      if (
        parts.length > 0 &&
        parts.every((part) => part === "true" || part === "false")
      ) {
        return PrimitiveTypes.boolean;
      }
    }

    if (trimmed.endsWith("[]")) {
      let base = trimmed;
      let dimensions = 0;
      while (base.endsWith("[]")) {
        base = base.slice(0, -2).trim();
        dimensions += 1;
      }
      const baseType = this.tryMapTypeScriptType(base);
      if (baseType === null) return null;
      let elementType: TypeSymbol = baseType;
      for (let i = 0; i < dimensions; i += 1) {
        elementType = new ArrayTypeSymbol(elementType);
      }
      return elementType;
    }

    const genericMatch = this.parseGenericType(trimmed);
    if (genericMatch) {
      const { base, args } = genericMatch;
      // Lazily resolve type args: only the cases that need them pay the
      // lookup cost, and `null` propagates so unmappable args surface a
      // hard error to callers that expect throwing semantics.
      const resolveArg = (i: number): TypeSymbol | null =>
        this.tryMapTypeScriptType(args[i] ?? "object");
      switch (base) {
        case "Array":
        case "ReadonlyArray": {
          const arg0 = resolveArg(0);
          if (arg0 === null) return null;
          return new ArrayTypeSymbol(arg0);
        }
        case "UdonList":
        case "List":
        case "UdonQueue":
        case "Queue":
        case "UdonStack":
        case "Stack":
        case "UdonHashSet":
        case "HashSet": {
          const arg0 = resolveArg(0);
          if (arg0 === null) return null;
          return new CollectionTypeSymbol(base, arg0);
        }
        case "UdonDictionary":
        case "Dictionary": {
          const arg0 = resolveArg(0);
          if (arg0 === null) return null;
          const arg1 = resolveArg(1);
          if (arg1 === null) return null;
          return new CollectionTypeSymbol(base, undefined, arg0, arg1);
        }
        case "Record":
          return ExternTypes.dataDictionary;
        case "Map":
        case "ReadonlyMap": {
          const arg0 = resolveArg(0);
          if (arg0 === null) return null;
          const arg1 = resolveArg(1);
          if (arg1 === null) return null;
          return new CollectionTypeSymbol(
            ExternTypes.dataDictionary.name,
            undefined,
            arg0,
            arg1,
          );
        }
        case "Set":
        case "ReadonlySet": {
          const arg0 = resolveArg(0);
          if (arg0 === null) return null;
          return new CollectionTypeSymbol(
            ExternTypes.dataDictionary.name,
            arg0,
            arg0,
            PrimitiveTypes.boolean,
          );
        }
        case "WeakSet":
        case "Iterator":
        case "Exclude":
        case "Extract":
        case "ReturnType":
        case "Partial":
        case "Required":
        case "Readonly":
        case "Pick":
        case "Omit":
          return ObjectType;
      }
    }

    const builtin = BUILTIN_NAME_MAP.get(trimmed);
    if (builtin) return builtin;

    // Set/Map/ReadonlySet/ReadonlyMap require parameterised CollectionTypeSymbol
    // construction (with key/value slots) so they are not part of BUILTIN_NAME_MAP.
    switch (trimmed) {
      case "Set":
      case "ReadonlySet":
        return new CollectionTypeSymbol(
          ExternTypes.dataDictionary.name,
          ObjectType,
          ObjectType,
          PrimitiveTypes.boolean,
        );
      case "Map":
      case "ReadonlyMap":
        return new CollectionTypeSymbol(
          ExternTypes.dataDictionary.name,
          undefined,
          ObjectType,
          ObjectType,
        );
    }

    if (this.isLikelyUserDefinedType(trimmed)) {
      return new ClassTypeSymbol(trimmed, UdonType.Object);
    }
    if (this.isComplexTypeExpression(trimmed)) {
      return ObjectType;
    }
    return null;
  }

  private isLikelyUserDefinedType(typeText: string): boolean {
    return /^[A-Z]\w*$/.test(typeText);
  }

  private normalizeGenericTypeParameterName(typeText: string): string | null {
    const normalized = typeText.startsWith("_") ? typeText.slice(1) : typeText;
    if (normalized === "T") return "T";
    if (/^T[A-Z0-9]\w*$/.test(normalized)) return normalized;
    return null;
  }

  private isComplexTypeExpression(typeText: string): boolean {
    if (typeText.startsWith("typeof ")) return true;
    return /[<>{}[\]|&?:.\s]/.test(typeText);
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
      if (char === "<") depth++;
      if (char === ">") depth--;
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

  private isStringLiteralUnionType(typeText: string): boolean {
    return STRING_LITERAL_UNION_RE.test(typeText.trim());
  }

  /**
   * Look up a TypeSymbol for a known builtin / extern name, without any
   * text-parsing fallback. Returns `null` when the name is not a registered
   * builtin (callers fall back to constructing `ClassTypeSymbol` themselves
   * or whatever else is appropriate). Use this from the TypeChecker resolver
   * where you already know the input is a single canonical name (e.g.
   * `Vector3`, `VRC.SDK3.Data.DataList`) — bypassing the regex / generic
   * parsing branches in `mapTypeScriptType` removes a class of false
   * positives (e.g. a user class literally named `T` matching the
   * generic-parameter regex).
   */
  lookupBuiltinByName(name: string): TypeSymbol | null {
    return BUILTIN_NAME_MAP.get(name) ?? null;
  }

  mapUdonType(udonType: UdonType): TypeSymbol {
    switch (udonType) {
      case UdonType.Int32:
        return PrimitiveTypes.int32;
      case UdonType.Single:
        return PrimitiveTypes.single;
      case UdonType.Boolean:
        return PrimitiveTypes.boolean;
      case UdonType.String:
        return PrimitiveTypes.string;
      case UdonType.Void:
        return PrimitiveTypes.void;
      case UdonType.Char:
      case UdonType.Decimal:
        // FQN-only types: they are emitted via UDON_TYPE_TO_CSHARP_FQN for
        // signature generation, but the symbol layer keeps them as ObjectType.
        return ObjectType;
      case UdonType.Byte:
        return PrimitiveTypes.byte;
      case UdonType.SByte:
        return PrimitiveTypes.sbyte;
      case UdonType.Int16:
        return PrimitiveTypes.int16;
      case UdonType.UInt16:
        return PrimitiveTypes.uint16;
      case UdonType.UInt32:
        return PrimitiveTypes.uint32;
      case UdonType.Int64:
        return PrimitiveTypes.int64;
      case UdonType.UInt64:
        return PrimitiveTypes.uint64;
      case UdonType.Double:
        return PrimitiveTypes.double;
      case UdonType.Vector2:
        return ExternTypes.vector2;
      case UdonType.Vector3:
        return ExternTypes.vector3;
      case UdonType.Vector4:
        return ExternTypes.vector4;
      case UdonType.Quaternion:
        return ExternTypes.quaternion;
      case UdonType.Color:
        return ExternTypes.color;
      case UdonType.Transform:
        return ExternTypes.transform;
      case UdonType.GameObject:
        return ExternTypes.gameObject;
      case UdonType.Material:
        return ExternTypes.material;
      case UdonType.Renderer:
        return ExternTypes.renderer;
      case UdonType.MeshRenderer:
        return ExternTypes.meshRenderer;
      case UdonType.Collider:
        return ExternTypes.collider;
      case UdonType.BoxCollider:
        return ExternTypes.boxCollider;
      case UdonType.SphereCollider:
        return ExternTypes.sphereCollider;
      case UdonType.Rigidbody:
        return ExternTypes.rigidbody;
      case UdonType.Camera:
        return ExternTypes.camera;
      case UdonType.Canvas:
        return ExternTypes.canvas;
      case UdonType.RectTransform:
        return ExternTypes.rectTransform;
      case UdonType.AudioSource:
        return ExternTypes.audioSource;
      case UdonType.AudioClip:
        return ExternTypes.audioClip;
      case UdonType.Animator:
        return ExternTypes.animator;
      case UdonType.Component:
        return ExternTypes.component;
      case UdonType.VRCPlayerApi:
        return ExternTypes.vrcPlayerApi;
      case UdonType.UdonBehaviour:
        return ExternTypes.udonBehaviour;
      case UdonType.NetworkEventTarget:
        return ExternTypes.networkEventTarget;
      case UdonType.DataList:
        return ExternTypes.dataList;
      case UdonType.DataDictionary:
        return ExternTypes.dataDictionary;
      case UdonType.DataToken:
        return ExternTypes.dataToken;
      case UdonType.Type:
        return ExternTypes.systemType;
      case UdonType.Array:
        return new ArrayTypeSymbol(ObjectType);
      case UdonType.NativeArray:
        // NativeArray is intentionally omitted from UDON_TYPE_TO_CSHARP_FQN;
        // it is handled by the NativeArrayTypeSymbol instanceof branch in typeSymbolToCSharp.
        return new NativeArrayTypeSymbol(ObjectType);
      default:
        return ObjectType;
    }
  }

  mapBrandedType(brandedType: string): TypeSymbol {
    return this.mapTypeScriptType(brandedType);
  }

  getUdonStorageType(symbol: TypeSymbol): UdonType {
    return symbol.udonType;
  }

  inferLiteralType(value: number | string | boolean | bigint): TypeSymbol {
    if (typeof value === "boolean") {
      return PrimitiveTypes.boolean;
    }
    if (typeof value === "string") {
      return PrimitiveTypes.string;
    }
    if (typeof value === "bigint") {
      return PrimitiveTypes.int64;
    }
    return PrimitiveTypes.single;
  }
}

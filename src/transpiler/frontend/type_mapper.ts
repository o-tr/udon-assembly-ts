import type { EnumRegistry } from "./enum_registry.js";
import {
  ArrayTypeSymbol,
  ClassTypeSymbol,
  ExternTypes,
  NativeArrayTypeSymbol,
  ObjectType,
  PrimitiveTypes,
  type TypeSymbol,
  UDON_BRANDED_TYPE_MAP,
} from "./type_symbols.js";
import { UdonType } from "./types.js";

// Bare upper-case identifier (Foo, MyClass, T, etc.). Used by
// `resolveByBareName` to decide whether an unresolved name should be
// constructed as a fresh `ClassTypeSymbol` (forward reference) or widened
// to ObjectType. NOT a syntactic type-text parse: matches the trimmed
// canonical name only, never composite shapes like `Foo[]` or `Foo<T>`.
// Lowercase-leading identifiers are intentionally excluded to mirror the
// legacy `isLikelyUserDefinedType` behavior — an unregistered lowercase
// name reaches the unresolved/error path. Exported so `parser/types.ts`
// can share the same definition for its own bare-name fallback chain.
export const BARE_USER_TYPE_NAME_RE = /^[A-Z]\w*$/;

/**
 * Canonical lookup of TypeScript / C# builtin type names that have a single
 * unambiguous Udon TypeSymbol counterpart. The sole consumer is
 * `lookupBuiltinByName` (and its caller `resolveByBareName`); name-only
 * resolution is the only path left in TypeMapper now that the legacy
 * text-parsing fallback has been removed.
 *
 * Entries that need parameterised construction (Set/Map/ReadonlySet/
 * ReadonlyMap → CollectionTypeSymbol with key/value slots) are intentionally
 * kept out of this table; the parser visitors construct them from the
 * `ts.TypeReferenceNode` directly via `mapTypeWithGenerics`.
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
  private unionAliases = new Map<string, TypeSymbol[]>();

  constructor(private enumRegistry?: EnumRegistry) {}

  getAlias(name: string): TypeSymbol | undefined {
    return this.typeAliases.get(name);
  }

  registerTypeAlias(name: string, symbol: TypeSymbol): void {
    this.typeAliases.set(name, symbol);
  }

  registerUnionAlias(name: string, parts: TypeSymbol[]): void {
    this.unionAliases.set(name, parts);
  }

  getUnionParts(name: string): TypeSymbol[] | undefined {
    return this.unionAliases.get(name);
  }

  /**
   * Look up a TypeSymbol for a known builtin / extern name, without any
   * text-parsing fallback. Returns `null` when the name is not a registered
   * builtin (callers fall back to constructing `ClassTypeSymbol` themselves
   * or whatever else is appropriate). Use this from the TypeChecker resolver
   * where you already know the input is a single canonical name (e.g.
   * `Vector3`, `VRC.SDK3.Data.DataList`).
   */
  lookupBuiltinByName(name: string): TypeSymbol | null {
    return BUILTIN_NAME_MAP.get(name) ?? null;
  }

  /**
   * Symbol-based enum lookup. Returns the primitive TypeSymbol for a
   * registered enum (`int32` or `string` depending on its kind), or `null`
   * when the name isn't registered.
   */
  lookupEnumByName(name: string): TypeSymbol | null {
    if (!this.enumRegistry?.isEnum(name)) return null;
    const kind = this.enumRegistry.getEnumKind(name);
    return kind === "string" ? PrimitiveTypes.string : PrimitiveTypes.int32;
  }

  /**
   * Resolve a single bare identifier (no generics, no unions, no `[]`) to a
   * TypeSymbol via the symbol-based chain: registered alias → builtin name →
   * fresh `ClassTypeSymbol` for an upper-case identifier (forward-reference
   * safety) → `ObjectType`. Never parses type text. Sole entry point for
   * name-only resolution shared between the parser's `inferType` `new`
   * branch and the IR `new Foo()` / fixed-name extern lookups.
   *
   * Enum lookup is intentionally omitted: `new EnumName()` and StringBuilder
   * / ctor-style references in IR have no use for the enum-as-primitive
   * mapping. Callers that need enum resolution should call
   * `lookupEnumByName` themselves before this.
   */
  resolveByBareName(name: string): TypeSymbol {
    return (
      this.getAlias(name) ??
      this.lookupBuiltinByName(name) ??
      (BARE_USER_TYPE_NAME_RE.test(name)
        ? new ClassTypeSymbol(name, UdonType.Object)
        : ObjectType)
    );
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

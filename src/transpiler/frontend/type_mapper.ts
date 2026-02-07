import type { EnumRegistry } from "./enum_registry.js";
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
import { UdonType } from "./types.js";

const warnedTypes = new Set<string>();

export class TypeMapper {
  private typeAliases = new Map<string, TypeSymbol>();

  constructor(private enumRegistry?: EnumRegistry) {}

  getAlias(name: string): TypeSymbol | undefined {
    return this.typeAliases.get(name);
  }

  registerTypeAlias(name: string, symbol: TypeSymbol): void {
    this.typeAliases.set(name, symbol);
  }

  mapTypeScriptType(tsType: string): TypeSymbol {
    const trimmed = tsType.trim();
    if (trimmed.startsWith("readonly ")) {
      return this.mapTypeScriptType(trimmed.slice(9));
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
        return this.mapTypeScriptType(parts[0]);
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
      let elementType: TypeSymbol = this.mapTypeScriptType(base);
      for (let i = 0; i < dimensions; i += 1) {
        elementType = new ArrayTypeSymbol(elementType);
      }
      return elementType;
    }

    const genericMatch = this.parseGenericType(trimmed);
    if (genericMatch) {
      const { base, args } = genericMatch;
      switch (base) {
        case "Array":
        case "ReadonlyArray":
          return new ArrayTypeSymbol(
            this.mapTypeScriptType(args[0] ?? "object"),
          );
        case "UdonList":
        case "List":
          return new CollectionTypeSymbol(
            base,
            this.mapTypeScriptType(args[0] ?? "object"),
          );
        case "UdonQueue":
        case "Queue":
          return new CollectionTypeSymbol(
            base,
            this.mapTypeScriptType(args[0] ?? "object"),
          );
        case "UdonStack":
        case "Stack":
          return new CollectionTypeSymbol(
            base,
            this.mapTypeScriptType(args[0] ?? "object"),
          );
        case "UdonHashSet":
        case "HashSet":
          return new CollectionTypeSymbol(
            base,
            this.mapTypeScriptType(args[0] ?? "object"),
          );
        case "UdonDictionary":
        case "Dictionary":
          return new CollectionTypeSymbol(
            base,
            undefined,
            this.mapTypeScriptType(args[0] ?? "object"),
            this.mapTypeScriptType(args[1] ?? "object"),
          );
        case "Record":
        case "Map":
          return ExternTypes.dataDictionary;
        case "Set":
        case "ReadonlySet":
          return new CollectionTypeSymbol(
            ExternTypes.dataDictionary.name,
            undefined,
            this.mapTypeScriptType(args[0] ?? "object"),
            PrimitiveTypes.boolean,
          );
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

    if (this.enumRegistry?.isEnum(trimmed)) {
      const kind = this.enumRegistry.getEnumKind(trimmed);
      return kind === "string" ? PrimitiveTypes.string : PrimitiveTypes.int32;
    }

    switch (trimmed) {
      case "number":
        return PrimitiveTypes.single;
      case "float":
        return PrimitiveTypes.single;
      case "boolean":
        return PrimitiveTypes.boolean;
      case "bool":
        return PrimitiveTypes.boolean;
      case "string":
        return PrimitiveTypes.string;
      case "object":
        return ExternTypes.dataDictionary;
      case "void":
        return PrimitiveTypes.void;
      case "int":
        return PrimitiveTypes.int32;
      case "short":
        return PrimitiveTypes.int16;
      case "ushort":
        return PrimitiveTypes.uint16;
      case "uint":
        return PrimitiveTypes.uint32;
      case "long":
        return PrimitiveTypes.int64;
      case "ulong":
        return PrimitiveTypes.uint64;
      case "byte":
        return PrimitiveTypes.byte;
      case "sbyte":
        return PrimitiveTypes.sbyte;
      case "double":
        return PrimitiveTypes.double;
      case "bigint":
        return PrimitiveTypes.int64;
      case "unknown":
      case "never":
      case "any":
        return ObjectType;
      case "Set":
      case "ReadonlySet":
        return new CollectionTypeSymbol(
          ExternTypes.dataDictionary.name,
          undefined,
          ObjectType,
          PrimitiveTypes.boolean,
        );
      case "UdonByte":
        return PrimitiveTypes.byte;
      case "UdonInt":
        return PrimitiveTypes.int32;
      case "UdonFloat":
        return PrimitiveTypes.single;
      case "UdonDouble":
        return PrimitiveTypes.double;
      case "UdonLong":
        return PrimitiveTypes.int64;
      case "UdonULong":
        return PrimitiveTypes.uint64;
      case "Vector2":
      case "UnityEngine.Vector2":
        return ExternTypes.vector2;
      case "Vector3":
      case "UnityEngine.Vector3":
        return ExternTypes.vector3;
      case "Vector4":
      case "UnityEngine.Vector4":
        return ExternTypes.vector4;
      case "Quaternion":
      case "UnityEngine.Quaternion":
        return ExternTypes.quaternion;
      case "Color":
      case "UnityEngine.Color":
        return ExternTypes.color;
      case "Transform":
      case "UnityEngine.Transform":
        return ExternTypes.transform;
      case "GameObject":
      case "UnityEngine.GameObject":
        return ExternTypes.gameObject;
      case "AudioSource":
      case "UnityEngine.AudioSource":
        return ExternTypes.audioSource;
      case "AudioClip":
      case "UnityEngine.AudioClip":
        return ExternTypes.audioClip;
      case "Animator":
      case "UnityEngine.Animator":
        return ExternTypes.animator;
      case "Component":
      case "UnityEngine.Component":
        return ExternTypes.component;
      case "VRCPlayerApi":
      case "VRC.SDKBase.VRCPlayerApi":
        return ExternTypes.vrcPlayerApi;
      case "UdonBehaviour":
      case "VRC.Udon.UdonBehaviour":
        return ExternTypes.udonBehaviour;
      case "DataList":
      case "VRC.SDK3.Data.DataList":
        return ExternTypes.dataList;
      case "DataDictionary":
      case "VRC.SDK3.Data.DataDictionary":
        return ExternTypes.dataDictionary;
      case "DataToken":
      case "VRC.SDK3.Data.DataToken":
        return ExternTypes.dataToken;
      case "Type":
      case "System.Type":
        return ExternTypes.systemType;
      default:
        if (this.isLikelyUserDefinedType(trimmed)) {
          return new ClassTypeSymbol(trimmed, UdonType.Object);
        }
        if (
          !warnedTypes.has(trimmed) &&
          !this.isComplexTypeExpression(trimmed)
        ) {
          warnedTypes.add(trimmed);
          // eslint-disable-next-line no-console
          console.warn(
            `transpiler: Unknown TypeScript type "${trimmed}" — falling back to object`,
          );
        }
        return ObjectType;
    }
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
    const trimmed = typeText.trim();
    const literal = `("[^"]*"|'[^']*')`;
    const pattern = new RegExp(`^${literal}(\\s*\\|\\s*${literal})+$`);
    return pattern.test(trimmed);
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

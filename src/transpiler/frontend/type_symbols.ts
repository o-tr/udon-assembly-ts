import { NUMERIC_RANK } from "./numeric_rank.js";
import { UdonType } from "./types.js";

export abstract class TypeSymbol {
  abstract get name(): string;
  abstract get udonType(): UdonType;
  abstract isAssignableTo(other: TypeSymbol): boolean;
}

export class PrimitiveTypeSymbol extends TypeSymbol {
  constructor(
    private readonly typeName: string,
    private readonly udon: UdonType,
  ) {
    super();
  }

  get name(): string {
    return this.typeName;
  }

  get udonType(): UdonType {
    return this.udon;
  }

  isAssignableTo(other: TypeSymbol): boolean {
    return this.udonType === other.udonType;
  }
}

export class ArrayTypeSymbol extends TypeSymbol {
  constructor(
    public readonly elementType: TypeSymbol,
    public readonly dimensions = 1,
  ) {
    super();
  }

  get name(): string {
    return `${this.elementType.name}${"[]".repeat(this.dimensions)}`;
  }

  get udonType(): UdonType {
    return UdonType.Array;
  }

  isAssignableTo(other: TypeSymbol): boolean {
    if (!(other instanceof ArrayTypeSymbol)) {
      return false;
    }
    return (
      this.dimensions === other.dimensions &&
      this.elementType.isAssignableTo(other.elementType)
    );
  }
}

/**
 * Maps UdonType element values to the corresponding Udon native array type name.
 * Only element types with a known Udon system array are included.
 */
const NATIVE_ARRAY_TYPE_NAMES: Partial<Record<UdonType, string>> = {
  [UdonType.Single]: "SystemSingleArray",
  [UdonType.Int32]: "SystemInt32Array",
  [UdonType.Boolean]: "SystemBooleanArray",
  [UdonType.String]: "SystemStringArray",
  [UdonType.Byte]: "SystemByteArray",
  [UdonType.SByte]: "SystemSByteArray",
  [UdonType.Int16]: "SystemInt16Array",
  [UdonType.UInt16]: "SystemUInt16Array",
  [UdonType.UInt32]: "SystemUInt32Array",
  [UdonType.Int64]: "SystemInt64Array",
  [UdonType.UInt64]: "SystemUInt64Array",
  [UdonType.Double]: "SystemDoubleArray",
};

/**
 * Returns the Udon native array type name for a given element UdonType,
 * or null if the element type has no corresponding native array.
 */
export function getNativeArrayTypeName(
  elementUdonType: UdonType,
): string | null {
  return NATIVE_ARRAY_TYPE_NAMES[elementUdonType] ?? null;
}

/**
 * Fixed-length typed native array backed by Udon system array types
 * (e.g. SystemSingleArray, SystemInt32Array).
 * Used when array length is known at compile time and no dynamic resize
 * operations (push/pop/splice/concat) are used.
 */
export class NativeArrayTypeSymbol extends TypeSymbol {
  constructor(public readonly elementType: TypeSymbol) {
    super();
  }

  /** The Udon native array type name, e.g. "SystemSingleArray". */
  get nativeUdonTypeName(): string {
    const name = NATIVE_ARRAY_TYPE_NAMES[this.elementType.udonType];
    if (!name) {
      throw new Error(
        `NativeArrayTypeSymbol created for unsupported element type: ${this.elementType.udonType}`,
      );
    }
    return name;
  }

  /**
   * Returns the Udon type name (e.g. "SystemSingleArray").
   * Intentionally does NOT end with "[]" to avoid the endsWith("[]")
   * DataList fallbacks in operands.ts and types.ts.
   */
  get name(): string {
    return this.nativeUdonTypeName;
  }

  get udonType(): UdonType {
    return UdonType.NativeArray;
  }

  isAssignableTo(other: TypeSymbol): boolean {
    if (!(other instanceof NativeArrayTypeSymbol)) {
      return false;
    }
    return this.elementType.isAssignableTo(other.elementType);
  }
}

export class DataListTypeSymbol extends TypeSymbol {
  constructor(public readonly elementType: TypeSymbol) {
    super();
  }

  get name(): string {
    return "DataList";
  }

  get udonType(): UdonType {
    return UdonType.DataList;
  }

  isAssignableTo(other: TypeSymbol): boolean {
    if (other.udonType === UdonType.DataList) {
      if (other instanceof DataListTypeSymbol) {
        return this.elementType.isAssignableTo(other.elementType);
      }
      return true;
    }
    return false;
  }
}

export class ClassTypeSymbol extends TypeSymbol {
  constructor(
    private readonly typeName: string,
    private readonly udon: UdonType,
    public readonly baseClass: ClassTypeSymbol | null = null,
    public readonly members: Map<string, TypeSymbol> = new Map(),
  ) {
    super();
  }

  get name(): string {
    return this.typeName;
  }

  get udonType(): UdonType {
    return this.udon;
  }

  isAssignableTo(other: TypeSymbol): boolean {
    if (this.udonType === other.udonType) {
      return true;
    }
    let current = this.baseClass;
    while (current) {
      if (current.udonType === other.udonType) {
        return true;
      }
      current = current.baseClass;
    }
    return false;
  }
}

export class CollectionTypeSymbol extends ClassTypeSymbol {
  constructor(
    typeName: string,
    public readonly elementType?: TypeSymbol,
    public readonly keyType?: TypeSymbol,
    public readonly valueType?: TypeSymbol,
  ) {
    super(
      typeName,
      (() => {
        switch (typeName) {
          case "DataDictionary":
            return UdonType.DataDictionary;
          case "DataList":
            return UdonType.DataList;
          default:
            return UdonType.Object;
        }
      })(),
    );
  }
}

export class GenericTypeParameterSymbol extends TypeSymbol {
  constructor(private readonly typeName: string) {
    super();
  }

  get name(): string {
    return this.typeName;
  }

  get udonType(): UdonType {
    return UdonType.Object;
  }

  isAssignableTo(_other: TypeSymbol): boolean {
    return true;
  }
}

export class InterfaceTypeSymbol extends TypeSymbol {
  constructor(
    private readonly typeName: string,
    public readonly methods: Map<
      string,
      { params: TypeSymbol[]; returnType: TypeSymbol }
    > = new Map(),
    public readonly properties: Map<string, TypeSymbol> = new Map(),
  ) {
    super();
  }

  get name(): string {
    return this.typeName;
  }

  get udonType(): UdonType {
    return UdonType.Object;
  }

  isAssignableTo(_other: TypeSymbol): boolean {
    return true;
  }
}

export class ExternTypeSymbol extends TypeSymbol {
  constructor(
    private readonly typeName: string,
    private readonly udon: UdonType,
  ) {
    super();
  }

  get name(): string {
    return this.typeName;
  }

  get udonType(): UdonType {
    return this.udon;
  }

  isAssignableTo(other: TypeSymbol): boolean {
    return (
      this.udonType === other.udonType || other.udonType === UdonType.Object
    );
  }
}

export class ObjectTypeSymbol extends TypeSymbol {
  get name(): string {
    return "object";
  }

  get udonType(): UdonType {
    return UdonType.Object;
  }

  isAssignableTo(_other: TypeSymbol): boolean {
    return true;
  }
}

const SIGNED_TYPES = new Set<UdonType>([
  UdonType.SByte,
  UdonType.Int16,
  UdonType.Int32,
  UdonType.Int64,
]);

/**
 * C#/.NET same-rank signed/unsigned promotion: when a signed and unsigned
 * type share the same rank, the result promotes per C# implicit conversion:
 *   sbyte + byte   → int   (Int32)  — C# promotes all narrow types to int
 *   short + ushort → int   (Int32)
 *   int   + uint   → long  (Int64)
 *   long  + ulong  → compile error in C#; we fall back to Int64.
 *
 * Lazily initialised because it references PrimitiveTypes (defined below).
 */
let _sameRankPromotion: Partial<Record<number, PrimitiveTypeSymbol>> | null =
  null;
function getSameRankPromotion(): Partial<Record<number, PrimitiveTypeSymbol>> {
  if (!_sameRankPromotion) {
    _sameRankPromotion = {
      1: PrimitiveTypes.int32, // sbyte + byte → int (C# promotes narrow types to int)
      2: PrimitiveTypes.int32, // short + ushort → int
      3: PrimitiveTypes.int64, // int + uint → long
      4: PrimitiveTypes.int64, // long + ulong → long (C# error; best-effort)
    };
  }
  return _sameRankPromotion;
}

/**
 * Returns the promoted numeric type for a binary operation between two
 * TypeSymbols, following C#/.NET implicit numeric promotion rules.
 * Returns null if either type is not numeric.
 */
export function getPromotedType(
  a: TypeSymbol,
  b: TypeSymbol,
): TypeSymbol | null {
  const rankA = NUMERIC_RANK[a.udonType];
  const rankB = NUMERIC_RANK[b.udonType];
  if (rankA === undefined || rankB === undefined) return null;
  if (rankA > rankB) return a;
  if (rankB > rankA) return b;
  // Same rank: if one is signed and one unsigned, promote to next wider signed type
  const aIsSigned = SIGNED_TYPES.has(a.udonType);
  const bIsSigned = SIGNED_TYPES.has(b.udonType);
  if (aIsSigned !== bIsSigned) {
    const promoted = getSameRankPromotion()[rankA];
    if (promoted) return promoted;
  }
  // Same rank, same signedness: no promotion needed.
  return a;
}

export const PrimitiveTypes = {
  int32: new PrimitiveTypeSymbol("int", UdonType.Int32),
  single: new PrimitiveTypeSymbol("float", UdonType.Single),
  boolean: new PrimitiveTypeSymbol("bool", UdonType.Boolean),
  string: new PrimitiveTypeSymbol("string", UdonType.String),
  void: new PrimitiveTypeSymbol("void", UdonType.Void),
  byte: new PrimitiveTypeSymbol("byte", UdonType.Byte),
  sbyte: new PrimitiveTypeSymbol("sbyte", UdonType.SByte),
  int16: new PrimitiveTypeSymbol("short", UdonType.Int16),
  uint16: new PrimitiveTypeSymbol("ushort", UdonType.UInt16),
  uint32: new PrimitiveTypeSymbol("uint", UdonType.UInt32),
  int64: new PrimitiveTypeSymbol("long", UdonType.Int64),
  uint64: new PrimitiveTypeSymbol("ulong", UdonType.UInt64),
  double: new PrimitiveTypeSymbol("double", UdonType.Double),
};

export const ExternTypes = {
  vector2: new ExternTypeSymbol("Vector2", UdonType.Vector2),
  vector3: new ExternTypeSymbol("Vector3", UdonType.Vector3),
  vector4: new ExternTypeSymbol("Vector4", UdonType.Vector4),
  quaternion: new ExternTypeSymbol("Quaternion", UdonType.Quaternion),
  color: new ExternTypeSymbol("Color", UdonType.Color),
  transform: new ExternTypeSymbol("Transform", UdonType.Transform),
  gameObject: new ExternTypeSymbol("GameObject", UdonType.GameObject),
  audioSource: new ExternTypeSymbol("AudioSource", UdonType.AudioSource),
  audioClip: new ExternTypeSymbol("AudioClip", UdonType.AudioClip),
  animator: new ExternTypeSymbol("Animator", UdonType.Animator),
  component: new ExternTypeSymbol("Component", UdonType.Component),
  vrcPlayerApi: new ExternTypeSymbol("VRCPlayerApi", UdonType.VRCPlayerApi),
  udonBehaviour: new ExternTypeSymbol("UdonBehaviour", UdonType.UdonBehaviour),
  systemType: new ExternTypeSymbol("Type", UdonType.Type),
  dataList: new ExternTypeSymbol("DataList", UdonType.DataList),
  dataDictionary: new ExternTypeSymbol(
    "DataDictionary",
    UdonType.DataDictionary,
  ),
  dataToken: new ExternTypeSymbol("DataToken", UdonType.DataToken),
};

export const UDON_BRANDED_TYPE_MAP: ReadonlyMap<string, PrimitiveTypeSymbol> =
  new Map([
    ["UdonByte", PrimitiveTypes.byte],
    ["UdonInt", PrimitiveTypes.int32],
    ["UdonFloat", PrimitiveTypes.single],
    ["UdonDouble", PrimitiveTypes.double],
    ["UdonLong", PrimitiveTypes.int64],
    ["UdonULong", PrimitiveTypes.uint64],
  ]);

export const ObjectType = new ObjectTypeSymbol();

export function isPlainObjectType(
  type: TypeSymbol | null | undefined,
): boolean {
  return (
    !!type &&
    type.name === ObjectType.name &&
    type.udonType === ObjectType.udonType
  );
}
/**
 * Maps a C# type name (from type metadata registry) to a TypeSymbol.
 */
export function mapCSharpTypeToTypeSymbol(
  csharpType: string,
): TypeSymbol | null {
  // Handle array types by mapping the element type
  if (csharpType.endsWith("[]")) {
    const elementType = mapCSharpTypeToTypeSymbol(csharpType.slice(0, -2));
    if (elementType) {
      return new ArrayTypeSymbol(elementType);
    }
    return null;
  }

  switch (csharpType) {
    case "System.String":
      return PrimitiveTypes.string;
    case "System.Boolean":
      return PrimitiveTypes.boolean;
    case "System.Byte":
      return PrimitiveTypes.byte;
    case "System.SByte":
      return PrimitiveTypes.sbyte;
    case "System.Int16":
      return PrimitiveTypes.int16;
    case "System.UInt16":
      return PrimitiveTypes.uint16;
    case "System.Int32":
      return PrimitiveTypes.int32;
    case "System.UInt32":
      return PrimitiveTypes.uint32;
    case "System.Int64":
      return PrimitiveTypes.int64;
    case "System.UInt64":
      return PrimitiveTypes.uint64;
    case "System.Single":
      return PrimitiveTypes.single;
    case "System.Double":
      return PrimitiveTypes.double;
    case "System.Object":
      return ObjectType;
    case "System.Void":
      return PrimitiveTypes.void;
    case "VRC.SDK3.Data.DataToken":
      return ExternTypes.dataToken;
    case "VRC.SDK3.Data.DataList":
      return ExternTypes.dataList;
    case "VRC.SDK3.Data.DataDictionary":
      return ExternTypes.dataDictionary;
    case "UnityEngine.Vector2":
      return ExternTypes.vector2;
    case "UnityEngine.Vector3":
      return ExternTypes.vector3;
    case "UnityEngine.Vector4":
      return ExternTypes.vector4;
    case "UnityEngine.Quaternion":
      return ExternTypes.quaternion;
    case "UnityEngine.Color":
      return ExternTypes.color;
    case "UnityEngine.Transform":
      return ExternTypes.transform;
    case "UnityEngine.GameObject":
      return ExternTypes.gameObject;
    case "UnityEngine.AudioSource":
      return ExternTypes.audioSource;
    case "UnityEngine.AudioClip":
      return ExternTypes.audioClip;
    case "UnityEngine.Animator":
      return ExternTypes.animator;
    case "UnityEngine.Component":
      return ExternTypes.component;
    case "System.Type":
      return ExternTypes.systemType;
    case "VRC.SDKBase.VRCPlayerApi":
      return ExternTypes.vrcPlayerApi;
    case "VRC.Udon.UdonBehaviour":
      return ExternTypes.udonBehaviour;
    default:
      return null;
  }
}

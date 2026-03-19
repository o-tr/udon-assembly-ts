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
    super(typeName, UdonType.Object);
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

export const ObjectType = new ObjectTypeSymbol();

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

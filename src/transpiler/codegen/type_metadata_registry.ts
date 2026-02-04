export interface MemberMetadata {
  ownerCsharpType: string;
  memberName: string;
  kind: "method" | "property" | "constructor";
  paramCsharpTypes: string[];
  returnCsharpType: string;
  isStatic: boolean;
}

export interface TypeMetadata {
  csharpFullName: string;
  tsName: string;
  members: Map<string, MemberMetadata[]>;
}

export class TypeMetadataRegistry {
  private types: Map<string, TypeMetadata> = new Map();

  registerType(metadata: TypeMetadata): void {
    this.types.set(metadata.tsName, metadata);
  }

  getMemberMetadata(
    tsTypeName: string,
    memberName: string,
  ): MemberMetadata | undefined {
    const type = this.types.get(tsTypeName);
    if (!type) return undefined;
    const candidates = type.members.get(memberName);
    return candidates?.[0];
  }

  resolveOverload(
    tsTypeName: string,
    memberName: string,
    argCount: number,
  ): MemberMetadata | undefined {
    const type = this.types.get(tsTypeName);
    if (!type) return undefined;
    const candidates = type.members.get(memberName) ?? [];
    return candidates.find(
      (member) => member.paramCsharpTypes.length === argCount,
    );
  }
}

export const typeMetadataRegistry = new TypeMetadataRegistry();

export function computeTypeId(typeName: string): bigint {
  const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < typeName.length; i++) {
    hash ^= BigInt(typeName.charCodeAt(i));
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return hash;
}

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.Material",
  tsName: "Material",
  members: new Map([
    [
      "SetColor",
      [
        {
          ownerCsharpType: "UnityEngine.Material",
          memberName: "SetColor",
          kind: "method",
          paramCsharpTypes: ["System.String", "UnityEngine.Color"],
          returnCsharpType: "System.Void",
          isStatic: false,
        },
      ],
    ],
    [
      "GetColor",
      [
        {
          ownerCsharpType: "UnityEngine.Material",
          memberName: "GetColor",
          kind: "method",
          paramCsharpTypes: ["System.String"],
          returnCsharpType: "UnityEngine.Color",
          isStatic: false,
        },
      ],
    ],
    [
      "SetFloat",
      [
        {
          ownerCsharpType: "UnityEngine.Material",
          memberName: "SetFloat",
          kind: "method",
          paramCsharpTypes: ["System.String", "System.Single"],
          returnCsharpType: "System.Void",
          isStatic: false,
        },
      ],
    ],
    [
      "color",
      [
        {
          ownerCsharpType: "UnityEngine.Material",
          memberName: "color",
          kind: "property",
          paramCsharpTypes: [],
          returnCsharpType: "UnityEngine.Color",
          isStatic: false,
        },
      ],
    ],
  ]),
});

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.Rigidbody",
  tsName: "Rigidbody",
  members: new Map([
    [
      "AddForce",
      [
        {
          ownerCsharpType: "UnityEngine.Rigidbody",
          memberName: "AddForce",
          kind: "method",
          paramCsharpTypes: ["UnityEngine.Vector3"],
          returnCsharpType: "System.Void",
          isStatic: false,
        },
      ],
    ],
  ]),
});

typeMetadataRegistry.registerType({
  csharpFullName: "VRC.SDKBase.VRCPlayerApi",
  tsName: "VRCPlayerApi",
  members: new Map([
    [
      "TeleportTo",
      [
        {
          ownerCsharpType: "VRC.SDKBase.VRCPlayerApi",
          memberName: "TeleportTo",
          kind: "method",
          paramCsharpTypes: ["UnityEngine.Vector3", "UnityEngine.Quaternion"],
          returnCsharpType: "System.Void",
          isStatic: false,
        },
      ],
    ],
    [
      "EnablePickup",
      [
        {
          ownerCsharpType: "VRC.SDKBase.VRCPlayerApi",
          memberName: "EnablePickup",
          kind: "method",
          paramCsharpTypes: ["System.Boolean"],
          returnCsharpType: "System.Void",
          isStatic: false,
        },
      ],
    ],
    [
      "SetVelocity",
      [
        {
          ownerCsharpType: "VRC.SDKBase.VRCPlayerApi",
          memberName: "SetVelocity",
          kind: "method",
          paramCsharpTypes: ["UnityEngine.Vector3"],
          returnCsharpType: "System.Void",
          isStatic: false,
        },
      ],
    ],
    [
      "GetBonePosition",
      [
        {
          ownerCsharpType: "VRC.SDKBase.VRCPlayerApi",
          memberName: "GetBonePosition",
          kind: "method",
          paramCsharpTypes: ["UnityEngine.HumanBodyBones"],
          returnCsharpType: "UnityEngine.Vector3",
          isStatic: false,
        },
      ],
    ],
    [
      "GetBoneRotation",
      [
        {
          ownerCsharpType: "VRC.SDKBase.VRCPlayerApi",
          memberName: "GetBoneRotation",
          kind: "method",
          paramCsharpTypes: ["UnityEngine.HumanBodyBones"],
          returnCsharpType: "UnityEngine.Quaternion",
          isStatic: false,
        },
      ],
    ],
    [
      "GetTrackingData",
      [
        {
          ownerCsharpType: "VRC.SDKBase.VRCPlayerApi",
          memberName: "GetTrackingData",
          kind: "method",
          paramCsharpTypes: ["VRC.SDKBase.VRCPlayerApi+TrackingDataType"],
          returnCsharpType: "VRC.SDKBase.VRCPlayerApi+TrackingData",
          isStatic: false,
        },
      ],
    ],
    [
      "IsUserInVR",
      [
        {
          ownerCsharpType: "VRC.SDKBase.VRCPlayerApi",
          memberName: "IsUserInVR",
          kind: "method",
          paramCsharpTypes: [],
          returnCsharpType: "System.Boolean",
          isStatic: false,
        },
      ],
    ],
    [
      "GetPlayerById",
      [
        {
          ownerCsharpType: "VRC.SDKBase.VRCPlayerApi",
          memberName: "GetPlayerById",
          kind: "method",
          paramCsharpTypes: ["System.Int32"],
          returnCsharpType: "VRC.SDKBase.VRCPlayerApi",
          isStatic: true,
        },
      ],
    ],
    [
      "IsValid",
      [
        {
          ownerCsharpType: "VRC.SDKBase.VRCPlayerApi",
          memberName: "IsValid",
          kind: "method",
          paramCsharpTypes: [],
          returnCsharpType: "System.Boolean",
          isStatic: false,
        },
      ],
    ],
    [
      "SetPlayerTag",
      [
        {
          ownerCsharpType: "VRC.SDKBase.VRCPlayerApi",
          memberName: "SetPlayerTag",
          kind: "method",
          paramCsharpTypes: ["System.String", "System.String"],
          returnCsharpType: "System.Void",
          isStatic: false,
        },
      ],
    ],
    [
      "GetPlayerTag",
      [
        {
          ownerCsharpType: "VRC.SDKBase.VRCPlayerApi",
          memberName: "GetPlayerTag",
          kind: "method",
          paramCsharpTypes: ["System.String"],
          returnCsharpType: "System.String",
          isStatic: false,
        },
      ],
    ],
  ]),
});

typeMetadataRegistry.registerType({
  csharpFullName: "VRC.SDK3.Data.DataList",
  tsName: "DataList",
  members: new Map([
    [
      "ctor",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataList",
          memberName: "ctor",
          kind: "constructor",
          paramCsharpTypes: [],
          returnCsharpType: "VRC.SDK3.Data.DataList",
          isStatic: false,
        },
      ],
    ],
    [
      "Add",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataList",
          memberName: "Add",
          kind: "method",
          paramCsharpTypes: ["VRC.SDK3.Data.DataToken"],
          returnCsharpType: "System.Void",
          isStatic: false,
        },
      ],
    ],
    [
      "get_Item",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataList",
          memberName: "get_Item",
          kind: "method",
          paramCsharpTypes: ["System.Int32"],
          returnCsharpType: "VRC.SDK3.Data.DataToken",
          isStatic: false,
        },
      ],
    ],
    [
      "set_Item",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataList",
          memberName: "set_Item",
          kind: "method",
          paramCsharpTypes: ["System.Int32", "VRC.SDK3.Data.DataToken"],
          returnCsharpType: "System.Void",
          isStatic: false,
        },
      ],
    ],
    [
      "Remove",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataList",
          memberName: "Remove",
          kind: "method",
          paramCsharpTypes: ["VRC.SDK3.Data.DataToken"],
          returnCsharpType: "System.Boolean",
          isStatic: false,
        },
      ],
    ],
    [
      "TryGetValue",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataList",
          memberName: "TryGetValue",
          kind: "method",
          paramCsharpTypes: ["System.Int32", "VRC.SDK3.Data.DataToken"],
          returnCsharpType: "System.Boolean",
          isStatic: false,
        },
      ],
    ],
    [
      "Count",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataList",
          memberName: "Count",
          kind: "property",
          paramCsharpTypes: [],
          returnCsharpType: "System.Int32",
          isStatic: false,
        },
      ],
    ],
  ]),
});

typeMetadataRegistry.registerType({
  csharpFullName: "VRC.SDK3.Data.DataDictionary",
  tsName: "DataDictionary",
  members: new Map([
    [
      "ctor",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataDictionary",
          memberName: "ctor",
          kind: "constructor",
          paramCsharpTypes: [],
          returnCsharpType: "VRC.SDK3.Data.DataDictionary",
          isStatic: false,
        },
      ],
    ],
    [
      "SetValue",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataDictionary",
          memberName: "SetValue",
          kind: "method",
          paramCsharpTypes: [
            "VRC.SDK3.Data.DataToken",
            "VRC.SDK3.Data.DataToken",
          ],
          returnCsharpType: "System.Void",
          isStatic: false,
        },
      ],
    ],
    [
      "TryGetValue",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataDictionary",
          memberName: "TryGetValue",
          kind: "method",
          paramCsharpTypes: [
            "VRC.SDK3.Data.DataToken",
            "VRC.SDK3.Data.DataToken",
          ],
          returnCsharpType: "System.Boolean",
          isStatic: false,
        },
      ],
    ],
    [
      "Remove",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataDictionary",
          memberName: "Remove",
          kind: "method",
          paramCsharpTypes: ["VRC.SDK3.Data.DataToken"],
          returnCsharpType: "System.Boolean",
          isStatic: false,
        },
      ],
    ],
    [
      "ContainsKey",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataDictionary",
          memberName: "ContainsKey",
          kind: "method",
          paramCsharpTypes: ["VRC.SDK3.Data.DataToken"],
          returnCsharpType: "System.Boolean",
          isStatic: false,
        },
      ],
    ],
    [
      "Count",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataDictionary",
          memberName: "Count",
          kind: "property",
          paramCsharpTypes: [],
          returnCsharpType: "System.Int32",
          isStatic: false,
        },
      ],
    ],
  ]),
});

typeMetadataRegistry.registerType({
  csharpFullName: "VRC.SDK3.Data.DataToken",
  tsName: "DataToken",
  members: new Map([
    [
      "ctor",
      [
        {
          ownerCsharpType: "VRC.SDK3.Data.DataToken",
          memberName: "ctor",
          kind: "constructor",
          paramCsharpTypes: ["System.Object"],
          returnCsharpType: "VRC.SDK3.Data.DataToken",
          isStatic: false,
        },
      ],
    ],
  ]),
});

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.Renderer",
  tsName: "Renderer",
  members: new Map(),
});

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.MeshRenderer",
  tsName: "MeshRenderer",
  members: new Map(),
});

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.Collider",
  tsName: "Collider",
  members: new Map(),
});

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.BoxCollider",
  tsName: "BoxCollider",
  members: new Map(),
});

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.SphereCollider",
  tsName: "SphereCollider",
  members: new Map(),
});

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.Camera",
  tsName: "Camera",
  members: new Map(),
});

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.Canvas",
  tsName: "Canvas",
  members: new Map(),
});

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.RectTransform",
  tsName: "RectTransform",
  members: new Map(),
});

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.UI.Image",
  tsName: "Image",
  members: new Map(),
});

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.UI.Text",
  tsName: "Text",
  members: new Map(),
});

typeMetadataRegistry.registerType({
  csharpFullName: "UnityEngine.ParticleSystem",
  tsName: "ParticleSystem",
  members: new Map(),
});

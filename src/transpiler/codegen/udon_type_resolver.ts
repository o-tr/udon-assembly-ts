export const TS_TO_CSHARP = new Map<string, string>([
  ["number", "System.Single"],
  ["boolean", "System.Boolean"],
  ["string", "System.String"],
  ["object", "System.Object"],
  ["void", "System.Void"],
  ["int", "System.Int32"],
  ["float", "System.Single"],
  ["bool", "System.Boolean"],
  ["double", "System.Double"],
  ["long", "System.Int64"],
  ["ulong", "System.UInt64"],
  ["short", "System.Int16"],
  ["ushort", "System.UInt16"],
  ["byte", "System.Byte"],
  ["sbyte", "System.SByte"],
  ["uint", "System.UInt32"],
  ["Vector2", "UnityEngine.Vector2"],
  ["Vector3", "UnityEngine.Vector3"],
  ["Vector4", "UnityEngine.Vector4"],
  ["Quaternion", "UnityEngine.Quaternion"],
  ["Transform", "UnityEngine.Transform"],
  ["GameObject", "UnityEngine.GameObject"],
  ["Material", "UnityEngine.Material"],
  ["Renderer", "UnityEngine.Renderer"],
  ["MeshRenderer", "UnityEngine.MeshRenderer"],
  ["Collider", "UnityEngine.Collider"],
  ["BoxCollider", "UnityEngine.BoxCollider"],
  ["SphereCollider", "UnityEngine.SphereCollider"],
  ["Rigidbody", "UnityEngine.Rigidbody"],
  ["Camera", "UnityEngine.Camera"],
  ["Canvas", "UnityEngine.Canvas"],
  ["RectTransform", "UnityEngine.RectTransform"],
  ["AudioSource", "UnityEngine.AudioSource"],
  ["AudioClip", "UnityEngine.AudioClip"],
  ["Animator", "UnityEngine.Animator"],
  ["Component", "UnityEngine.Component"],
  ["Color", "UnityEngine.Color"],
  ["VRCPlayerApi", "VRC.SDKBase.VRCPlayerApi"],
  ["UdonBehaviour", "VRC.Udon.UdonBehaviour"],
  ["NetworkEventTarget", "VRC.Udon.Common.Enums.NetworkEventTarget"],
  ["DataList", "VRC.SDK3.Data.DataList"],
  ["DataDictionary", "VRC.SDK3.Data.DataDictionary"],
  ["DataToken", "VRC.SDK3.Data.DataToken"],
  ["Type", "System.Type"],
  ["Object", "System.Object"],
]);

export function toUdonTypeName(csharpFullName: string): string {
  return csharpFullName.replace(/[.+]/g, "");
}

export function applySpecialTypeReplacements(udonName: string): string {
  return udonName.replace(
    "VRCUdonUdonBehaviour",
    "VRCUdonCommonInterfacesIUdonEventReceiver",
  );
}

export function toUdonTypeNameWithArray(csharpFullName: string): string {
  if (csharpFullName.endsWith("[]")) {
    const base = toUdonTypeName(csharpFullName.slice(0, -2));
    return applySpecialTypeReplacements(`${base}Array`);
  }
  return applySpecialTypeReplacements(toUdonTypeName(csharpFullName));
}

export function mapTypeScriptToCSharp(tsType: string): string {
  const trimmed = tsType.trim();
  if (trimmed.endsWith("[]")) {
    const element = trimmed.slice(0, -2);
    const mapped = TS_TO_CSHARP.get(element) ?? element;
    return `${mapped}[]`;
  }
  return TS_TO_CSHARP.get(trimmed) ?? trimmed;
}

export function generateExternSignature(
  ownerCsharpType: string,
  methodName: string,
  paramCsharpTypes: string[],
  returnCsharpType: string,
  isRef?: boolean[],
): string {
  const ownerUdon = toUdonTypeNameWithArray(ownerCsharpType);
  const paramsUdon = paramCsharpTypes
    .map((param, index) => {
      const base = toUdonTypeNameWithArray(param);
      return isRef?.[index] ? `${base}Ref` : base;
    })
    .join("_");
  const returnUdon = toUdonTypeNameWithArray(returnCsharpType);

  if (paramsUdon) {
    return `${ownerUdon}.__${methodName}__${paramsUdon}__${returnUdon}`;
  }
  return `${ownerUdon}.__${methodName}____${returnUdon}`;
}

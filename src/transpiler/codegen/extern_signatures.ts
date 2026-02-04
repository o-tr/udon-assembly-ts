import { typeMetadataRegistry } from "./type_metadata_registry.js";
import {
  generateExternSignature,
  mapTypeScriptToCSharp,
} from "./udon_type_resolver.js";

export const EXTERN_METHODS = new Map<string, string>([
  ["Debug.Log", "UnityEngineDebug.__Log__SystemObject__SystemVoid"],
  [
    "Debug.LogWarning",
    "UnityEngineDebug.__LogWarning__SystemObject__SystemVoid",
  ],
  ["Debug.LogError", "UnityEngineDebug.__LogError__SystemObject__SystemVoid"],
  ["Time.deltaTime", "UnityEngineTime.__get_deltaTime__SystemSingle"],
  ["Time.time", "UnityEngineTime.__get_time__SystemSingle"],
  ["Vector3.magnitude", "UnityEngineVector3.__get_magnitude__SystemSingle"],
  [
    "Vector3.normalized",
    "UnityEngineVector3.__get_normalized__UnityEngineVector3",
  ],
  [
    "Vector3.Distance",
    "UnityEngineVector3.__Distance__UnityEngineVector3_UnityEngineVector3__SystemSingle",
  ],
  [
    "Transform.position",
    "UnityEngineTransform.__get_position__UnityEngineVector3",
  ],
  [
    "Transform.rotation",
    "UnityEngineTransform.__get_rotation__UnityEngineQuaternion",
  ],
  [
    "VRCPlayerApi.GetPosition",
    "VRCSDKBaseVRCPlayerApi.__GetPosition__UnityEngineVector3",
  ],
  [
    "VRCPlayerApi.displayName",
    "VRCSDKBaseVRCPlayerApi.__get_displayName__SystemString",
  ],
  [
    "VRCPlayerApi.playerId",
    "VRCSDKBaseVRCPlayerApi.__get_playerId__SystemInt32",
  ],
  [
    "Networking.LocalPlayer",
    "VRCSDKBaseNetworking.__get_LocalPlayer__VRCSDKBaseVRCPlayerApi",
  ],
  ["Networking.IsMaster", "VRCSDKBaseNetworking.__get_IsMaster__SystemBoolean"],
  [
    "Networking.IsOwner",
    "VRCSDKBaseNetworking.__IsOwner__VRCSDKBaseVRCPlayerApi_UnityEngineGameObject__SystemBoolean",
  ],
  // Mathf (UnityEngine)
  ["Mathf.Abs", "UnityEngineMathf.__Abs__SystemSingle__SystemSingle"],
  ["Mathf.Ceil", "UnityEngineMathf.__Ceil__SystemSingle__SystemSingle"],
  [
    "Mathf.CeilToInt",
    "UnityEngineMathf.__CeilToInt__SystemSingle__SystemInt32",
  ],
  [
    "Mathf.Clamp",
    "UnityEngineMathf.__Clamp__SystemSingle_SystemSingle_SystemSingle__SystemSingle",
  ],
  ["Mathf.Clamp01", "UnityEngineMathf.__Clamp01__SystemSingle__SystemSingle"],
  ["Mathf.Floor", "UnityEngineMathf.__Floor__SystemSingle__SystemSingle"],
  [
    "Mathf.FloorToInt",
    "UnityEngineMathf.__FloorToInt__SystemSingle__SystemInt32",
  ],
  [
    "Mathf.Lerp",
    "UnityEngineMathf.__Lerp__SystemSingle_SystemSingle_SystemSingle__SystemSingle",
  ],
  [
    "Mathf.Max",
    "UnityEngineMathf.__Max__SystemSingle_SystemSingle__SystemSingle",
  ],
  [
    "Mathf.Min",
    "UnityEngineMathf.__Min__SystemSingle_SystemSingle__SystemSingle",
  ],
  [
    "Mathf.Pow",
    "UnityEngineMathf.__Pow__SystemSingle_SystemSingle__SystemSingle",
  ],
  ["Mathf.Round", "UnityEngineMathf.__Round__SystemSingle__SystemSingle"],
  [
    "Mathf.RoundToInt",
    "UnityEngineMathf.__RoundToInt__SystemSingle__SystemInt32",
  ],
  ["Mathf.Sin", "UnityEngineMathf.__Sin__SystemSingle__SystemSingle"],
  ["Mathf.Cos", "UnityEngineMathf.__Cos__SystemSingle__SystemSingle"],
  ["Mathf.Sqrt", "UnityEngineMathf.__Sqrt__SystemSingle__SystemSingle"],
  ["Mathf.Tan", "UnityEngineMathf.__Tan__SystemSingle__SystemSingle"],
  // String methods
  ["String.Contains", "SystemString.__Contains__SystemString__SystemBoolean"],
  [
    "String.StartsWith",
    "SystemString.__StartsWith__SystemString__SystemBoolean",
  ],
  ["String.EndsWith", "SystemString.__EndsWith__SystemString__SystemBoolean"],
  ["String.IndexOf", "SystemString.__IndexOf__SystemString__SystemInt32"],
  [
    "String.Substring(i)",
    "SystemString.__Substring__SystemInt32__SystemString",
  ],
  [
    "String.Substring(i,l)",
    "SystemString.__Substring__SystemInt32_SystemInt32__SystemString",
  ],
  ["String.ToLower", "SystemString.__ToLower__SystemString"],
  ["String.ToUpper", "SystemString.__ToUpper__SystemString"],
  ["String.Trim", "SystemString.__Trim__SystemString"],
  // GameObject methods
  [
    "GameObject.SetActive",
    "UnityEngineGameObject.__SetActive__SystemBoolean__SystemVoid",
  ],
  [
    "GameObject.Find",
    "UnityEngineGameObject.__Find__SystemString__UnityEngineGameObject",
  ],
  // Transform methods
  [
    "Transform.GetChild",
    "UnityEngineTransform.__GetChild__SystemInt32__UnityEngineTransform",
  ],
  // AudioSource
  ["AudioSource.Play", "UnityEngineAudioSource.__Play__SystemVoid"],
  ["AudioSource.Stop", "UnityEngineAudioSource.__Stop__SystemVoid"],
  [
    "AudioSource.PlayOneShot",
    "UnityEngineAudioSource.__PlayOneShot__UnityEngineAudioClip__SystemVoid",
  ],
  [
    "AudioSource.get_isPlaying",
    "UnityEngineAudioSource.__get_isPlaying__SystemBoolean",
  ],
  [
    "AudioSource.set_volume",
    "UnityEngineAudioSource.__set_volume__SystemSingle__SystemVoid",
  ],
  // Animator
  [
    "Animator.SetBool",
    "UnityEngineAnimator.__SetBool__SystemString_SystemBoolean__SystemVoid",
  ],
  [
    "Animator.SetFloat",
    "UnityEngineAnimator.__SetFloat__SystemString_SystemSingle__SystemVoid",
  ],
  [
    "Animator.SetInteger",
    "UnityEngineAnimator.__SetInteger__SystemString_SystemInt32__SystemVoid",
  ],
  [
    "Animator.SetTrigger",
    "UnityEngineAnimator.__SetTrigger__SystemString__SystemVoid",
  ],
  [
    "Animator.GetBool",
    "UnityEngineAnimator.__GetBool__SystemString__SystemBoolean",
  ],
  [
    "Animator.GetFloat",
    "UnityEngineAnimator.__GetFloat__SystemString__SystemSingle",
  ],
  [
    "Animator.GetInteger",
    "UnityEngineAnimator.__GetInteger__SystemString__SystemInt32",
  ],
  // Vector3
  [
    "Vector3.Lerp",
    "UnityEngineVector3.__Lerp__UnityEngineVector3_UnityEngineVector3_SystemSingle__UnityEngineVector3",
  ],
  [
    "Vector3.Cross",
    "UnityEngineVector3.__Cross__UnityEngineVector3_UnityEngineVector3__UnityEngineVector3",
  ],
  [
    "Vector3.Dot",
    "UnityEngineVector3.__Dot__UnityEngineVector3_UnityEngineVector3__SystemSingle",
  ],
  [
    "Vector3.Angle",
    "UnityEngineVector3.__Angle__UnityEngineVector3_UnityEngineVector3__SystemSingle",
  ],
  ["Vector3.get_zero", "UnityEngineVector3.__get_zero__UnityEngineVector3"],
  ["Vector3.get_one", "UnityEngineVector3.__get_one__UnityEngineVector3"],
  ["Vector3.get_up", "UnityEngineVector3.__get_up__UnityEngineVector3"],
  [
    "Vector3.get_forward",
    "UnityEngineVector3.__get_forward__UnityEngineVector3",
  ],
  // Quaternion
  [
    "Quaternion.Euler",
    "UnityEngineQuaternion.__Euler__SystemSingle_SystemSingle_SystemSingle__UnityEngineQuaternion",
  ],
  [
    "Quaternion.Lerp",
    "UnityEngineQuaternion.__Lerp__UnityEngineQuaternion_UnityEngineQuaternion_SystemSingle__UnityEngineQuaternion",
  ],
  [
    "Quaternion.get_identity",
    "UnityEngineQuaternion.__get_identity__UnityEngineQuaternion",
  ],
  // UdonSharp Collections
  ["UdonList.Add", "UdonSharpRuntime_List.__Add__T__SystemVoid"],
  ["UdonList.Remove", "UdonSharpRuntime_List.__Remove__T__SystemBoolean"],
  [
    "UdonList.RemoveAt",
    "UdonSharpRuntime_List.__RemoveAt__SystemInt32__SystemVoid",
  ],
  [
    "UdonList.RemoveRange",
    "UdonSharpRuntime_List.__RemoveRange__SystemInt32_SystemInt32__SystemVoid",
  ],
  ["UdonList.Clear", "UdonSharpRuntime_List.__Clear__SystemVoid"],
  ["UdonList.Contains", "UdonSharpRuntime_List.__Contains__T__SystemBoolean"],
  ["UdonList.IndexOf", "UdonSharpRuntime_List.__IndexOf__T__SystemInt32"],
  [
    "UdonList.Insert",
    "UdonSharpRuntime_List.__Insert__SystemInt32_T__SystemVoid",
  ],
  ["UdonList.Sort", "UdonSharpRuntime_List.__Sort__SystemVoid"],
  ["UdonList.Reverse", "UdonSharpRuntime_List.__Reverse__SystemVoid"],
  ["UdonList.ToArray", "UdonSharpRuntime_List.__ToArray__TArray"],
  ["UdonList.get_Item", "UdonSharpRuntime_List.__get_Item__SystemInt32__T"],
  [
    "UdonList.set_Item",
    "UdonSharpRuntime_List.__set_Item__SystemInt32_T__SystemVoid",
  ],
  [
    "UdonList.GetEnumerator",
    "UdonSharpRuntime_List.__GetEnumerator__SystemCollectionsIEnumerator",
  ],
  [
    "UdonList.CreateFromArray",
    "UdonSharpRuntime_List.__CreateFromArray__TArray__UdonSharpRuntime_List",
  ],
  [
    "UdonList.CreateFromHashSet",
    "UdonSharpRuntime_List.__CreateFromHashSet__UdonSharpRuntime_HashSet__UdonSharpRuntime_List",
  ],

  [
    "UdonDictionary.Add",
    "UdonSharpRuntime_Dictionary.__Add__TKey_TValue__SystemVoid",
  ],
  [
    "UdonDictionary.Remove",
    "UdonSharpRuntime_Dictionary.__Remove__TKey__SystemBoolean",
  ],
  [
    "UdonDictionary.ContainsKey",
    "UdonSharpRuntime_Dictionary.__ContainsKey__TKey__SystemBoolean",
  ],
  [
    "UdonDictionary.ContainsValue",
    "UdonSharpRuntime_Dictionary.__ContainsValue__TValue__SystemBoolean",
  ],
  [
    "UdonDictionary.TryGetValue",
    "UdonSharpRuntime_Dictionary.__TryGetValue__TKey_TValue__SystemBoolean",
  ],
  ["UdonDictionary.Clear", "UdonSharpRuntime_Dictionary.__Clear__SystemVoid"],
  [
    "UdonDictionary.get_Item",
    "UdonSharpRuntime_Dictionary.__get_Item__TKey__TValue",
  ],
  [
    "UdonDictionary.set_Item",
    "UdonSharpRuntime_Dictionary.__set_Item__TKey_TValue__SystemVoid",
  ],
  [
    "UdonDictionary.GetEnumerator",
    "UdonSharpRuntime_Dictionary.__GetEnumerator__UdonSharpRuntime_DictionaryIterator",
  ],

  ["UdonQueue.Enqueue", "UdonSharpRuntime_Queue.__Enqueue__T__SystemVoid"],
  ["UdonQueue.Dequeue", "UdonSharpRuntime_Queue.__Dequeue__T"],
  [
    "UdonQueue.TryDequeue",
    "UdonSharpRuntime_Queue.__TryDequeue__T__SystemBoolean",
  ],
  ["UdonQueue.TryPeek", "UdonSharpRuntime_Queue.__TryPeek__T__SystemBoolean"],
  ["UdonQueue.Peek", "UdonSharpRuntime_Queue.__Peek__T"],
  ["UdonQueue.ToArray", "UdonSharpRuntime_Queue.__ToArray__TArray"],
  ["UdonQueue.Contains", "UdonSharpRuntime_Queue.__Contains__T__SystemBoolean"],
  [
    "UdonQueue.GetEnumerator",
    "UdonSharpRuntime_Queue.__GetEnumerator__UdonSharpRuntime_QueueIterator",
  ],
  ["UdonQueue.Clear", "UdonSharpRuntime_Queue.__Clear__SystemVoid"],

  ["UdonStack.Push", "UdonSharpRuntime_Stack.__Push__T__SystemVoid"],
  ["UdonStack.Pop", "UdonSharpRuntime_Stack.__Pop__T"],
  ["UdonStack.Peek", "UdonSharpRuntime_Stack.__Peek__T"],
  ["UdonStack.TryPeek", "UdonSharpRuntime_Stack.__TryPeek__T__SystemBoolean"],
  ["UdonStack.TryPop", "UdonSharpRuntime_Stack.__TryPop__T__SystemBoolean"],
  ["UdonStack.ToArray", "UdonSharpRuntime_Stack.__ToArray__TArray"],
  ["UdonStack.TrimExcess", "UdonSharpRuntime_Stack.__TrimExcess__SystemVoid"],
  ["UdonStack.Contains", "UdonSharpRuntime_Stack.__Contains__T__SystemBoolean"],
  [
    "UdonStack.GetEnumerator",
    "UdonSharpRuntime_Stack.__GetEnumerator__UdonSharpRuntime_StackIterator",
  ],
  ["UdonStack.Clear", "UdonSharpRuntime_Stack.__Clear__SystemVoid"],

  ["UdonHashSet.Add", "UdonSharpRuntime_HashSet.__Add__T__SystemBoolean"],
  ["UdonHashSet.Remove", "UdonSharpRuntime_HashSet.__Remove__T__SystemBoolean"],
  [
    "UdonHashSet.Contains",
    "UdonSharpRuntime_HashSet.__Contains__T__SystemBoolean",
  ],
  ["UdonHashSet.Clear", "UdonSharpRuntime_HashSet.__Clear__SystemVoid"],
  [
    "UdonHashSet.UnionWith",
    "UdonSharpRuntime_HashSet.__UnionWith__UdonSharpRuntime_HashSet__SystemVoid",
  ],
  [
    "UdonHashSet.IntersectWith",
    "UdonSharpRuntime_HashSet.__IntersectWith__UdonSharpRuntime_HashSet__SystemVoid",
  ],
  [
    "UdonHashSet.ExceptWith",
    "UdonSharpRuntime_HashSet.__ExceptWith__UdonSharpRuntime_HashSet__SystemVoid",
  ],
  [
    "UdonHashSet.SymmetricExceptWith",
    "UdonSharpRuntime_HashSet.__SymmetricExceptWith__UdonSharpRuntime_HashSet__SystemVoid",
  ],
  [
    "UdonHashSet.IsSubsetOf",
    "UdonSharpRuntime_HashSet.__IsSubsetOf__UdonSharpRuntime_HashSet__SystemBoolean",
  ],
  [
    "UdonHashSet.IsSupersetOf",
    "UdonSharpRuntime_HashSet.__IsSupersetOf__UdonSharpRuntime_HashSet__SystemBoolean",
  ],
  [
    "UdonHashSet.IsProperSubsetOf",
    "UdonSharpRuntime_HashSet.__IsProperSubsetOf__UdonSharpRuntime_HashSet__SystemBoolean",
  ],
  [
    "UdonHashSet.IsProperSupersetOf",
    "UdonSharpRuntime_HashSet.__IsProperSupersetOf__UdonSharpRuntime_HashSet__SystemBoolean",
  ],
  [
    "UdonHashSet.Overlaps",
    "UdonSharpRuntime_HashSet.__Overlaps__UdonSharpRuntime_HashSet__SystemBoolean",
  ],
  [
    "UdonHashSet.SetEquals",
    "UdonSharpRuntime_HashSet.__SetEquals__UdonSharpRuntime_HashSet__SystemBoolean",
  ],
  ["UdonHashSet.ToArray", "UdonSharpRuntime_HashSet.__ToArray__TArray"],
  [
    "UdonHashSet.GetEnumerator",
    "UdonSharpRuntime_HashSet.__GetEnumerator__UdonSharpRuntime_HashSetIterator",
  ],
  [
    "UdonHashSet.CreateFromArray",
    "UdonSharpRuntime_HashSet.__CreateFromArray__TArray__UdonSharpRuntime_HashSet",
  ],
  [
    "UdonHashSet.CreateFromList",
    "UdonSharpRuntime_HashSet.__CreateFromList__UdonSharpRuntime_List__UdonSharpRuntime_HashSet",
  ],
  // GetComponentShim
  [
    "GetComponentShim.GetComponent",
    "UdonSharpLibInternalGetComponentShim.__GetComponent__UnityEngineComponent_SystemInt64__UnityEngineComponent",
  ],
  [
    "GetComponentShim.GetComponentInChildren",
    "UdonSharpLibInternalGetComponentShim.__GetComponentInChildren__UnityEngineComponent_SystemInt64__UnityEngineComponent",
  ],
  [
    "GetComponentShim.GetComponentInParent",
    "UdonSharpLibInternalGetComponentShim.__GetComponentInParent__UnityEngineComponent_SystemInt64__UnityEngineComponent",
  ],
  // UdonSharpBehaviour reflection helpers
  [
    "UdonSharpBehaviour.GetUdonTypeID",
    "UdonSharpBehaviour.__GetUdonTypeID__SystemInt64",
  ],
  [
    "UdonSharpBehaviour.GetUdonTypeName",
    "UdonSharpBehaviour.__GetUdonTypeName__SystemString",
  ],
  [
    "VRCInstantiate.Instantiate",
    "VRCInstantiate.__Instantiate__UnityEngineGameObject__UnityEngineGameObject",
  ],
  ["Type.GetType", "SystemType.__GetType__SystemString__SystemType"],
]);

export const EXTERN_PROPERTIES = new Map<
  string,
  { getter: string; setter?: string }
>([
  [
    "Transform.position",
    {
      getter: "UnityEngineTransform.__get_position__UnityEngineVector3",
      setter:
        "UnityEngineTransform.__set_position__UnityEngineVector3__SystemVoid",
    },
  ],
  [
    "Transform.localPosition",
    {
      getter: "UnityEngineTransform.__get_localPosition__UnityEngineVector3",
      setter:
        "UnityEngineTransform.__set_localPosition__UnityEngineVector3__SystemVoid",
    },
  ],
  [
    "Transform.localRotation",
    {
      getter: "UnityEngineTransform.__get_localRotation__UnityEngineQuaternion",
      setter:
        "UnityEngineTransform.__set_localRotation__UnityEngineQuaternion__SystemVoid",
    },
  ],
  [
    "Transform.localScale",
    {
      getter: "UnityEngineTransform.__get_localScale__UnityEngineVector3",
      setter:
        "UnityEngineTransform.__set_localScale__UnityEngineVector3__SystemVoid",
    },
  ],
  [
    "Transform.parent",
    {
      getter: "UnityEngineTransform.__get_parent__UnityEngineTransform",
    },
  ],
  [
    "Transform.childCount",
    {
      getter: "UnityEngineTransform.__get_childCount__SystemInt32",
    },
  ],
  [
    "GameObject.activeSelf",
    {
      getter: "UnityEngineGameObject.__get_activeSelf__SystemBoolean",
    },
  ],
  [
    "GameObject.name",
    {
      getter: "UnityEngineGameObject.__get_name__SystemString",
    },
  ],
  [
    "GameObject.transform",
    {
      getter: "UnityEngineGameObject.__get_transform__UnityEngineTransform",
    },
  ],
  [
    "String.length",
    {
      getter: "SystemString.__get_Length__SystemInt32",
    },
  ],
  [
    "AudioSource.isPlaying",
    {
      getter: "UnityEngineAudioSource.__get_isPlaying__SystemBoolean",
    },
  ],
  [
    "AudioSource.volume",
    {
      getter: "UnityEngineAudioSource.__get_volume__SystemSingle",
      setter: "UnityEngineAudioSource.__set_volume__SystemSingle__SystemVoid",
    },
  ],
  [
    "UdonList.Count",
    {
      getter: "UdonSharpRuntime_List.__get_Count__SystemInt32",
    },
  ],
  [
    "UdonDictionary.Count",
    {
      getter: "UdonSharpRuntime_Dictionary.__get_Count__SystemInt32",
    },
  ],
  [
    "UdonQueue.Count",
    {
      getter: "UdonSharpRuntime_Queue.__get_Count__SystemInt32",
    },
  ],
  [
    "UdonStack.Count",
    {
      getter: "UdonSharpRuntime_Stack.__get_Count__SystemInt32",
    },
  ],
  [
    "UdonHashSet.Count",
    {
      getter: "UdonSharpRuntime_HashSet.__get_Count__SystemInt32",
    },
  ],
]);

export const EXTERN_CONSTRUCTORS = new Map<string, string>([
  [
    "Vector3",
    "UnityEngineVector3.__ctor__SystemSingle_SystemSingle_SystemSingle__UnityEngineVector3",
  ],
  [
    "Color",
    "UnityEngineColor.__ctor__SystemSingle_SystemSingle_SystemSingle_SystemSingle__UnityEngineColor",
  ],
  ["UdonList", "UdonSharpRuntime_List.__ctor____UdonSharpRuntime_List"],
  [
    "UdonDictionary",
    "UdonSharpRuntime_Dictionary.__ctor____UdonSharpRuntime_Dictionary",
  ],
  ["UdonQueue", "UdonSharpRuntime_Queue.__ctor____UdonSharpRuntime_Queue"],
  ["UdonStack", "UdonSharpRuntime_Stack.__ctor____UdonSharpRuntime_Stack"],
  [
    "UdonHashSet",
    "UdonSharpRuntime_HashSet.__ctor____UdonSharpRuntime_HashSet",
  ],
]);

export function resolveExternSignature(
  typeName: string,
  memberName: string,
  accessType: "method" | "getter" | "setter",
  paramTypes?: string[],
  returnType?: string,
): string | null {
  const key = `${typeName}.${memberName}`;
  if (accessType === "getter") {
    const staticGetter = EXTERN_PROPERTIES.get(key)?.getter ?? null;
    if (staticGetter) return staticGetter;
  }
  if (accessType === "setter") {
    const staticSetter = EXTERN_PROPERTIES.get(key)?.setter ?? null;
    if (staticSetter) return staticSetter;
  }
  if (accessType === "method" && memberName === "ctor") {
    const staticCtor = EXTERN_CONSTRUCTORS.get(typeName) ?? null;
    if (staticCtor) return staticCtor;
  }
  if (accessType === "method") {
    const staticMethod = EXTERN_METHODS.get(key) ?? null;
    if (staticMethod) return staticMethod;
  }

  const metadata =
    paramTypes && paramTypes.length > 0
      ? typeMetadataRegistry.resolveOverload(
          typeName,
          memberName,
          paramTypes.length,
        )
      : typeMetadataRegistry.getMemberMetadata(typeName, memberName);
  if (metadata) {
    if (metadata.kind === "property") {
      const methodName =
        accessType === "setter" ? `set_${memberName}` : `get_${memberName}`;
      const params = accessType === "setter" ? [metadata.returnCsharpType] : [];
      const returnCsharp =
        accessType === "setter" ? "System.Void" : metadata.returnCsharpType;
      return generateExternSignature(
        metadata.ownerCsharpType,
        methodName,
        params,
        returnCsharp,
      );
    }
    const methodName =
      accessType === "getter"
        ? `get_${memberName}`
        : accessType === "setter"
          ? `set_${memberName}`
          : memberName;
    return generateExternSignature(
      metadata.ownerCsharpType,
      methodName,
      metadata.paramCsharpTypes,
      metadata.returnCsharpType,
    );
  }

  if (paramTypes && returnType) {
    const csharpOwner = mapTypeScriptToCSharp(typeName);
    const csharpParams = paramTypes.map(mapTypeScriptToCSharp);
    const csharpReturn = mapTypeScriptToCSharp(returnType);
    const methodName =
      accessType === "getter"
        ? `get_${memberName}`
        : accessType === "setter"
          ? `set_${memberName}`
          : memberName;
    return generateExternSignature(
      csharpOwner,
      methodName,
      csharpParams,
      csharpReturn,
    );
  }

  return null;
}

export function resolveConstructorSignature(typeName: string): string | null {
  return EXTERN_CONSTRUCTORS.get(typeName) ?? null;
}

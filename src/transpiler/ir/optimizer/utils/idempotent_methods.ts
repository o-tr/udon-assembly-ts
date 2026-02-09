export const idempotentMethods = new Set<string>([
  // Double-underscore format (produced by resolveExternSignature)
  "UnityEngineComponent.__get_transform____UnityEngineTransform",
  "UnityEngineComponent.__get_gameObject____UnityEngineGameObject",
  "UnityEngineVector3.__get_zero____UnityEngineVector3",
  "UnityEngineVector3.__get_one____UnityEngineVector3",
  "UnityEngineVector3.__get_up____UnityEngineVector3",
  "UnityEngineVector3.__get_down____UnityEngineVector3",
  "UnityEngineVector3.__get_left____UnityEngineVector3",
  "UnityEngineVector3.__get_right____UnityEngineVector3",
  "UnityEngineVector3.__get_forward____UnityEngineVector3",
  "UnityEngineVector3.__get_back____UnityEngineVector3",
  "UnityEngineQuaternion.__get_identity____UnityEngineQuaternion",
  // Single-underscore format (legacy/direct usage)
  "UnityEngineComponent.__get_transform__UnityEngineTransform",
  "UnityEngineComponent.__get_gameObject__UnityEngineGameObject",
  "UnityEngineVector3.__get_zero__UnityEngineVector3",
  "UnityEngineVector3.__get_one__UnityEngineVector3",
  "UnityEngineVector3.__get_up__UnityEngineVector3",
  "UnityEngineVector3.__get_down__UnityEngineVector3",
  "UnityEngineVector3.__get_left__UnityEngineVector3",
  "UnityEngineVector3.__get_right__UnityEngineVector3",
  "UnityEngineVector3.__get_forward__UnityEngineVector3",
  "UnityEngineVector3.__get_back__UnityEngineVector3",
  "UnityEngineQuaternion.__get_identity__UnityEngineQuaternion",
]);

export const isIdempotentMethod = (signature: string): boolean => {
  return idempotentMethods.has(signature);
};

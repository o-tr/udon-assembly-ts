export const idempotentMethods = new Set<string>([
  "UnityEngineComponent.__get_transform__UnityEngineTransform",
  "UnityEngineComponent.__get_gameObject__UnityEngineGameObject",
  "UnityEngineGameObject.__get_transform__UnityEngineTransform",
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

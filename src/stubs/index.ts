/**
 * VRChat UdonSharp スタブのバレルエクスポート
 */

// 配列型定義
export type { UdonArray } from "./ArrayTypes.js";
// DataContainer型定義
export { DataDictionary, DataList, DataToken } from "./DataContainerTypes.js";
// 同期可能型（型定義とガード）
export type {
  PackedSyncDelta,
  // PackedState型
  PackedSyncGameState,
  TileId,
} from "./SyncableTypes.js";
export { SyncableTypeGuards } from "./SyncableTypes.js";
// デコレーター
export { TsOnly, UdonStatic, UdonStub, UdonTsOnly } from "./UdonDecorators.js";
// Udon型定義
export {
  // 既存の型
  type NetworkEventTarget,
  type Syncable,
  // 数値型
  type UdonByte,
  type UdonDouble,
  type UdonEventArg,
  type UdonFloat,
  type UdonInt,
  type UdonLong,
  type UdonSynced,
  type UdonSyncMode,
  type UdonSyncType,
  UdonTypeConverters,
  type UdonULong,
} from "./UdonTypes.js";
// UnityEngine / TMPro 型スタブ
export {
  Animator,
  AudioSource,
  Bounds,
  BoxCollider,
  Button,
  Canvas,
  CanvasGroup,
  Color,
  Component,
  Debug,
  GameObject,
  Image,
  Material,
  Mathf,
  MeshFilter,
  MeshRenderer,
  Quaternion,
  RawImage,
  RectTransform,
  Renderer,
  TextMeshPro,
  TextMeshProUGUI,
  Time,
  Toggle,
  Transform,
  UnityObject,
  Vector2,
  Vector3,
} from "./UnityTypes.js";
// VRChat SDK型定義
export {
  Networking,
  type VRChatNetworking,
  VRChatStubFactory,
  type VRCPickup,
  VRCPlayerApi,
  type VRCStation,
} from "./VRChatTypes.js";

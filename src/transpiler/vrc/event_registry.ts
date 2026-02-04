import { UdonType } from "../frontend/types.js";

export interface VrcEventDefinition {
  udonName: string;
  tsName: string;
  parameters: Array<{ name: string; type: UdonType }>;
}

const VRC_EVENTS: VrcEventDefinition[] = [
  { udonName: "_start", tsName: "Start", parameters: [] },
  { udonName: "_update", tsName: "Update", parameters: [] },
  { udonName: "_lateUpdate", tsName: "LateUpdate", parameters: [] },
  { udonName: "_fixedUpdate", tsName: "FixedUpdate", parameters: [] },
  {
    udonName: "_onPlayerJoined",
    tsName: "OnPlayerJoined",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  {
    udonName: "_onPlayerLeft",
    tsName: "OnPlayerLeft",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  { udonName: "_interact", tsName: "Interact", parameters: [] },
  { udonName: "_onPickup", tsName: "OnPickup", parameters: [] },
  { udonName: "_onDrop", tsName: "OnDrop", parameters: [] },
  { udonName: "_onPickupUseDown", tsName: "OnPickupUseDown", parameters: [] },
  { udonName: "_onPickupUseUp", tsName: "OnPickupUseUp", parameters: [] },
  {
    udonName: "_onDeserialization",
    tsName: "OnDeserialization",
    parameters: [],
  },
  {
    udonName: "_onPreSerialization",
    tsName: "OnPreSerialization",
    parameters: [],
  },
  {
    udonName: "_onOwnershipRequest",
    tsName: "OnOwnershipRequest",
    parameters: [
      { name: "requestingPlayer", type: UdonType.VRCPlayerApi },
      { name: "requestedOwner", type: UdonType.VRCPlayerApi },
    ],
  },
  {
    udonName: "_onOwnershipTransferred",
    tsName: "OnOwnershipTransferred",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  { udonName: "_onTriggerEnter", tsName: "OnTriggerEnter", parameters: [] },
  { udonName: "_onTriggerExit", tsName: "OnTriggerExit", parameters: [] },
  { udonName: "_onCollisionEnter", tsName: "OnCollisionEnter", parameters: [] },
  { udonName: "_onCollisionExit", tsName: "OnCollisionExit", parameters: [] },
  {
    udonName: "_onPlayerTriggerEnter",
    tsName: "OnPlayerTriggerEnter",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  {
    udonName: "_onPlayerTriggerStay",
    tsName: "OnPlayerTriggerStay",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  {
    udonName: "_onPlayerTriggerExit",
    tsName: "OnPlayerTriggerExit",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  {
    udonName: "_onPlayerCollisionEnter",
    tsName: "OnPlayerCollisionEnter",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  {
    udonName: "_onPlayerCollisionStay",
    tsName: "OnPlayerCollisionStay",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  {
    udonName: "_onPlayerCollisionExit",
    tsName: "OnPlayerCollisionExit",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  {
    udonName: "_onPlayerRespawn",
    tsName: "OnPlayerRespawn",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  { udonName: "_onStationEntered", tsName: "OnStationEntered", parameters: [] },
  { udonName: "_onStationExited", tsName: "OnStationExited", parameters: [] },
  { udonName: "_onVideoPlay", tsName: "OnVideoPlay", parameters: [] },
  { udonName: "_onVideoEnd", tsName: "OnVideoEnd", parameters: [] },
  { udonName: "_onVideoPause", tsName: "OnVideoPause", parameters: [] },
  { udonName: "_onVideoStart", tsName: "OnVideoStart", parameters: [] },
  {
    udonName: "_onVideoError",
    tsName: "OnVideoError",
    parameters: [{ name: "videoError", type: UdonType.Object }],
  },
  { udonName: "_onVideoReady", tsName: "OnVideoReady", parameters: [] },
  { udonName: "_onVideoLoop", tsName: "OnVideoLoop", parameters: [] },
  {
    udonName: "_inputJump",
    tsName: "InputJump",
    parameters: [{ name: "value", type: UdonType.Boolean }],
  },
  {
    udonName: "_inputGrab",
    tsName: "InputGrab",
    parameters: [{ name: "value", type: UdonType.Boolean }],
  },
  {
    udonName: "_inputMoveHorizontal",
    tsName: "InputMoveHorizontal",
    parameters: [{ name: "value", type: UdonType.Single }],
  },
  {
    udonName: "_inputMoveVertical",
    tsName: "InputMoveVertical",
    parameters: [{ name: "value", type: UdonType.Single }],
  },
  {
    udonName: "_inputLookHorizontal",
    tsName: "InputLookHorizontal",
    parameters: [{ name: "value", type: UdonType.Single }],
  },
  {
    udonName: "_inputLookVertical",
    tsName: "InputLookVertical",
    parameters: [{ name: "value", type: UdonType.Single }],
  },
  {
    udonName: "_midiNoteOn",
    tsName: "MidiNoteOn",
    parameters: [
      { name: "channel", type: UdonType.Int32 },
      { name: "number", type: UdonType.Int32 },
      { name: "velocity", type: UdonType.Int32 },
    ],
  },
  {
    udonName: "_midiNoteOff",
    tsName: "MidiNoteOff",
    parameters: [
      { name: "channel", type: UdonType.Int32 },
      { name: "number", type: UdonType.Int32 },
      { name: "velocity", type: UdonType.Int32 },
    ],
  },
  {
    udonName: "_midiControlChange",
    tsName: "MidiControlChange",
    parameters: [
      { name: "channel", type: UdonType.Int32 },
      { name: "number", type: UdonType.Int32 },
      { name: "value", type: UdonType.Int32 },
    ],
  },
  {
    udonName: "_onMasterTransferred",
    tsName: "OnMasterTransferred",
    parameters: [{ name: "newMaster", type: UdonType.VRCPlayerApi }],
  },
  { udonName: "_onSpawn", tsName: "OnSpawn", parameters: [] },
  {
    udonName: "_onAvatarChanged",
    tsName: "OnAvatarChanged",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  {
    udonName: "_onAvatarEyeHeightChanged",
    tsName: "OnAvatarEyeHeightChanged",
    parameters: [
      { name: "player", type: UdonType.VRCPlayerApi },
      { name: "eyeHeightAsMeters", type: UdonType.Single },
    ],
  },
  {
    udonName: "_onPlayerDataUpdated",
    tsName: "OnPlayerDataUpdated",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  {
    udonName: "_onPlayerRestored",
    tsName: "OnPlayerRestored",
    parameters: [{ name: "player", type: UdonType.VRCPlayerApi }],
  },
  { udonName: "_onEnable", tsName: "OnEnable", parameters: [] },
  { udonName: "_onDisable", tsName: "OnDisable", parameters: [] },
];

const EVENT_MAP = new Map<string, VrcEventDefinition>(
  VRC_EVENTS.map((event) => [event.tsName, event]),
);

export function isVrcEvent(methodName: string): boolean {
  return EVENT_MAP.has(methodName);
}

export function getVrcEventDefinition(
  methodName: string,
): VrcEventDefinition | undefined {
  return EVENT_MAP.get(methodName);
}

export function isVrcEventLabel(label: string): boolean {
  return VRC_EVENTS.some((event) => event.udonName === label);
}

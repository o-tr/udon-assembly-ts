/**
 * UdonSharpBehaviour 用スタブクラス。
 *
 * TypeScript 側のコンパイル用に、UdonSharpBehaviour が提供する主要メソッドの
 * スタブをまとめて定義する。
 */
import { UdonStub } from "./UdonDecorators.js";
import type { NetworkEventTarget, UdonEventArg } from "./UdonTypes.js";
import type { VRCPlayerApi } from "./VRChatTypes.js";

type UdonInputEventArgs = unknown;
type VRCVideoError = unknown;
type VRCImageDownloadResult = unknown;
type VRCStringDownloadResult = unknown;
type VRCAsyncGPUReadbackRequest = unknown;
type VRCControllerColliderHit = unknown;
type VRCSerializationResult = unknown;
type VRCDeserializationResult = unknown;

@UdonStub("UdonSharp.UdonSharpBehaviour")
export class UdonSharpBehaviour {
  // ---------------------------------------------------------------------------
  // UdonSharp core helpers
  // ---------------------------------------------------------------------------

  GetProgramVariable(_name: string): unknown {
    return null;
  }

  SetProgramVariable(_name: string, _value: unknown): void {}

  SendCustomEvent(_eventName: string): void {}

  /**
   * カスタムネットワークイベントを送信
   * @param target - 送信先（"All" | "Owner" | "Local"）
   * @param eventName - イベント名
   * @param args - イベント引数
   */
  sendCustomNetworkEvent(
    _target: NetworkEventTarget,
    _eventName: string,
    ..._args: UdonEventArg[]
  ): void {}

  SendCustomEventDelayedSeconds(
    _eventName: string,
    _delaySeconds: number,
    _eventTiming?: unknown,
  ): void {}

  SendCustomEventDelayedFrames(
    _eventName: string,
    _delayFrames: number,
    _eventTiming?: unknown,
  ): void {}

  DisableInteractive: boolean = false;

  InteractionText: string = "";

  protected static VRCInstantiate<T>(_original: T): T {
    return _original;
  }

  RequestSerialization(): void {}

  GetUdonTypeID(): number {
    return 0;
  }

  static GetUdonTypeID<_T extends UdonSharpBehaviour>(): number {
    return 0;
  }

  GetUdonTypeName(): string {
    return "";
  }

  static GetUdonTypeName<_T extends UdonSharpBehaviour>(): string {
    return "";
  }

  // ---------------------------------------------------------------------------
  // Event stubs (UdonSharpBehaviour.cs に準拠)
  // ---------------------------------------------------------------------------

  PostLateUpdate(): void {}
  Interact(): void {}

  OnAvatarChanged(_player: VRCPlayerApi): void {}
  OnAvatarEyeHeightChanged(
    _player: VRCPlayerApi,
    _prevEyeHeightAsMeters: number,
  ): void {}
  OnDrop(): void {}

  OnOwnershipTransferred(_player: VRCPlayerApi): void {}

  OnPickup(): void {}
  OnPickupUseDown(): void {}
  OnPickupUseUp(): void {}

  OnPlayerJoined(_player: VRCPlayerApi): void {}
  OnPlayerLeft(_player: VRCPlayerApi): void {}
  OnSpawn(): void {}
  OnStationEntered(_player?: VRCPlayerApi): void {}
  OnStationExited(_player?: VRCPlayerApi): void {}

  OnVideoEnd(): void {}
  OnVideoError(_videoError: VRCVideoError): void {}
  OnVideoLoop(): void {}
  OnVideoPause(): void {}
  OnVideoPlay(): void {}
  OnVideoReady(): void {}
  OnVideoStart(): void {}

  OnPreSerialization(): void {}
  OnDeserialization(_result: VRCDeserializationResult): void {}

  OnPlayerTriggerEnter(_player: VRCPlayerApi): void {}
  OnPlayerTriggerExit(_player: VRCPlayerApi): void {}
  OnPlayerTriggerStay(_player: VRCPlayerApi): void {}

  OnPlayerCollisionEnter(_player: VRCPlayerApi): void {}
  OnPlayerCollisionExit(_player: VRCPlayerApi): void {}
  OnPlayerCollisionStay(_player: VRCPlayerApi): void {}

  OnPlayerParticleCollision(_player: VRCPlayerApi): void {}
  OnControllerColliderHitPlayer(_hit: VRCControllerColliderHit): void {}
  OnPlayerRespawn(_player: VRCPlayerApi): void {}

  OnImageLoadSuccess(_result: VRCImageDownloadResult): void {}
  OnImageLoadError(_result: VRCImageDownloadResult): void {}
  OnStringLoadSuccess(_result: VRCStringDownloadResult): void {}
  OnStringLoadError(_result: VRCStringDownloadResult): void {}

  OnPostSerialization(_result: VRCSerializationResult): void {}

  OnOwnershipRequest(
    _requestingPlayer: VRCPlayerApi,
    _requestedOwner: VRCPlayerApi,
  ): boolean {
    return true;
  }

  MidiNoteOn(_channel: number, _number: number, _velocity: number): void {}
  MidiNoteOff(_channel: number, _number: number, _velocity: number): void {}
  MidiControlChange(_channel: number, _number: number, _value: number): void {}

  InputJump(_value: boolean, _args: UdonInputEventArgs): void {}
  InputUse(_value: boolean, _args: UdonInputEventArgs): void {}
  InputGrab(_value: boolean, _args: UdonInputEventArgs): void {}
  InputDrop(_value: boolean, _args: UdonInputEventArgs): void {}
  InputMoveHorizontal(_value: number, _args: UdonInputEventArgs): void {}
  InputMoveVertical(_value: number, _args: UdonInputEventArgs): void {}
  InputLookHorizontal(_value: number, _args: UdonInputEventArgs): void {}
  InputLookVertical(_value: number, _args: UdonInputEventArgs): void {}

  OnAsyncGpuReadbackComplete(_request: VRCAsyncGPUReadbackRequest): void {}
}

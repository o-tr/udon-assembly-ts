/**
 * VRChat SDK型定義スタブ
 *
 * このファイルはTypeScriptコンパイル用のスタブであり、
 * 実際のVRChat SDK (C#) の型を模倣している。
 * VRChat上での実行時には、UdonSharpの対応する型が使用される。
 */

/**
 * VRChatプレイヤーAPI
 *
 * VRChatでプレイヤー情報にアクセスするためのAPI。
 * UdonSharpではVRCPlayerApiクラスとして提供される。
 *
 * @example
 * ```csharp
 * // UdonSharp (C#)
 * VRCPlayerApi localPlayer = Networking.LocalPlayer;
 * string displayName = localPlayer.displayName;
 * int playerId = localPlayer.playerId;
 * ```
 */
import { UdonStub } from "./UdonDecorators.js";
import { type UdonInt, UdonTypeConverters } from "./UdonTypes.js";
import type { GameObject, Quaternion, Vector3 } from "./UnityTypes.js";

@UdonStub("UnityEngine.HumanBodyBones")
export class HumanBodyBones {}

@UdonStub("VRC.SDKBase.VRCPlayerApi+TrackingDataType")
export class TrackingDataType {}

@UdonStub("VRC.SDKBase.VRCPlayerApi+TrackingData")
export class TrackingData {
  position: Vector3 = null as unknown as Vector3;
  rotation: Quaternion = null as unknown as Quaternion;
}

@UdonStub("VRC.SDKBase.VRCPlayerApi")
export class VRCPlayerApi {
  /**
   * 接続中プレイヤー一覧（スタブ用）
   * UdonSharp実環境ではSDK側が管理する
   */
  private static players: VRCPlayerApi[] = [];

  /**
   * 接続中プレイヤー数を取得
   */
  static GetPlayerCount(): UdonInt {
    return VRCPlayerApi.players.length as UdonInt;
  }

  /**
   * 接続中プレイヤーを取得
   * @param buffer - プレイヤー格納先配列
   * @returns 取得件数
   */
  static GetPlayers(buffer: VRCPlayerApi[]): UdonInt {
    const count = Math.min(buffer.length, VRCPlayerApi.players.length);
    for (let i = 0; i < count; i += 1) {
      buffer[i] = VRCPlayerApi.players[i];
    }
    return count as UdonInt;
  }

  /**
   * プレイヤーIDから取得
   */
  static GetPlayerById(playerId: UdonInt): VRCPlayerApi | null {
    for (const player of VRCPlayerApi.players) {
      if (player.playerId === playerId) {
        return player;
      }
    }
    return null;
  }

  /**
   * スタブ用: プレイヤー一覧を更新
   * UdonSharp実環境では使用されない
   */
  static __setPlayersForTesting(players: VRCPlayerApi[]): void {
    VRCPlayerApi.players = [...players];
  }

  /** プレイヤーの一意識別子（ワールド内でユニーク） */
  playerId: UdonInt;

  /** プレイヤーの表示名 */
  displayName: string;

  /** このプレイヤーがインスタンスマスターかどうか */
  isMaster: boolean;

  /** このプレイヤーがローカルプレイヤー（自分自身）かどうか */
  isLocal: boolean;

  /** プレイヤーがワールド内に存在するかどうか */
  isValid: boolean;

  /** プレイヤーの位置を取得 */
  GetPosition(): Vector3 {
    return null as unknown as Vector3;
  }

  TeleportTo(_position: Vector3, _rotation: Quaternion): void {}

  EnablePickup(_enable: boolean): void {}

  SetVelocity(_velocity: Vector3): void {}

  GetBonePosition(_bone: HumanBodyBones): Vector3 {
    return null as unknown as Vector3;
  }

  GetBoneRotation(_bone: HumanBodyBones): Quaternion {
    return null as unknown as Quaternion;
  }

  GetTrackingData(_type: TrackingDataType): TrackingData {
    return new TrackingData();
  }

  IsUserInVR(): boolean {
    return false;
  }

  constructor(
    playerId: UdonInt,
    displayName: string,
    isMaster: boolean = false,
    isLocal: boolean = false,
    isValid: boolean = true,
  ) {
    this.playerId = playerId;
    this.displayName = displayName;
    this.isMaster = isMaster;
    this.isLocal = isLocal;
    this.isValid = isValid;
  }
}

/**
 * VRChatステーションスタブ
 *
 * VRChatのステーション（座席など）を表すスタブ。
 * プレイヤーがステーションに入ると、そのステーションの制御下に入る。
 *
 * 麻雀ワールドでは各プレイヤーの座席として使用可能。
 */
export type VRCStation = {
  /** ステーションが使用中かどうか */
  isOccupied: boolean;

  /** ステーションを使用しているプレイヤー（未使用時はisValid=false） */
  occupant: VRCPlayerApi;

  /**
   * プレイヤーをステーションに入れる
   * @param player - ステーションに入れるプレイヤー
   */
  useStation(player: VRCPlayerApi): void;

  /**
   * プレイヤーをステーションから退出させる
   * @param player - ステーションから退出させるプレイヤー
   */
  exitStation(player: VRCPlayerApi): void;
};

/**
 * VRChatピックアップスタブ
 *
 * VRChatでプレイヤーが掴めるオブジェクトを表すスタブ。
 * 麻雀ワールドでは牌の操作に使用可能だが、
 * 現在の設計では直接的なピックアップは使用しない方針。
 */
export type VRCPickup = {
  /** ピックアップが現在掴まれているかどうか */
  isHeld: boolean;

  /** ピックアップを掴んでいるプレイヤー（未使用時はisValid=false） */
  currentPlayer: VRCPlayerApi;

  /**
   * ピックアップを強制的にドロップさせる
   *
   * 現在掴んでいるプレイヤーがいる場合、強制的に離させる。
   */
  drop(): void;

  /**
   * Generate haptic feedback for a specific player
   * @param player - Player to receive haptic feedback
   */
  generateHapticEvent(player: VRCPlayerApi): void;
};

/**
 * VRChatネットワーキングユーティリティ
 *
 * スタブでは実装を省略するが、参照用に型定義のみ提供。
 * 実際のUdonSharpではNetworkingクラスを使用する。
 */
export type VRChatNetworking = {
  localPlayer: VRCPlayerApi;
  getOwner(gameObject: unknown): VRCPlayerApi;
  setOwner(player: VRCPlayerApi, gameObject: unknown): void;
  isOwner(gameObject: unknown): boolean;
};

/**
 * UdonSharp Networking スタブ
 */
@UdonStub("VRC.SDKBase.Networking")
export class Networking {
  static LocalPlayer: VRCPlayerApi | null = null;
  static IsMaster: boolean = false;

  static GetOwner(_gameObject: unknown): VRCPlayerApi | null {
    return null;
  }

  static SetOwner(_player: VRCPlayerApi, _gameObject: unknown): void {}

  static IsOwner(_gameObject: unknown): boolean {
    return false;
  }

  static GetServerTimeInMilliseconds(): number {
    return Date.now();
  }
}

@UdonStub("VRC.SDKBase.VRCInstantiate")
export class VRCInstantiate {
  static Instantiate(_obj: GameObject): GameObject {
    return null as unknown as GameObject;
  }
}

export class VRChatStubFactory {
  /**
   * VRCプレイヤーAPIのスタブファクトリ
   *
   * テスト用にVRCPlayerApiのモックを生成する。
   */
  static createMockVRCPlayerApi(
    playerId: UdonInt,
    displayName: string,
    isMaster: boolean = false,
    isLocal: boolean = false,
  ): VRCPlayerApi {
    return new VRCPlayerApi(playerId, displayName, isMaster, isLocal, true);
  }

  /**
   * ステーションスタブのファクトリ
   *
   * テスト用にVRCStationのモックを生成する。
   */
  static createMockVRCStation(): VRCStation {
    const emptyPlayer: VRCPlayerApi = new VRCPlayerApi(
      UdonTypeConverters.toUdonInt(-1),
      "",
      false,
      false,
      false,
    );
    let _occupant: VRCPlayerApi = emptyPlayer;

    return {
      get isOccupied() {
        return _occupant.isValid;
      },
      get occupant() {
        return _occupant;
      },
      useStation(player: VRCPlayerApi) {
        if (_occupant.isValid) {
          throw new Error("Cannot use station: station is already occupied");
        }
        _occupant = player;
      },
      exitStation(player: VRCPlayerApi) {
        if (!_occupant.isValid) {
          throw new Error("Cannot exit station: station is not occupied");
        }
        if (_occupant.playerId !== player.playerId) {
          throw new Error(
            "Cannot exit station: player is not the current occupant",
          );
        }
        _occupant = emptyPlayer;
      },
    };
  }
}

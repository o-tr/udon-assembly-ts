/**
 * UdonSharp用型定義スタブ
 *
 * このファイルはTypeScriptコンパイル用のスタブであり、
 * 実際のUdonSharp (C#) 実装で対応するコードに置き換えられる。
 *
 * UdonSharpにはTypeScriptのnumber型に相当する型が存在しないため、
 * 各C#数値型に対応するブランド型を定義する。
 */

// =============================================================================
// UdonSharp数値型（ブランド型）
// =============================================================================

/**
 * UdonSharp byte型（C# byte: 0-255）
 * TypeScriptでは number として扱うが、型レベルで区別する
 */
export type UdonByte = number & { readonly __brand: "UdonByte" };

/**
 * UdonSharp int型（C# int: -2,147,483,648 to 2,147,483,647）
 * TypeScriptでは number として扱うが、型レベルで区別する
 */
export type UdonInt = number & { readonly __brand: "UdonInt" };

/**
 * UdonSharp float型（C# float: 単精度浮動小数点）
 * TypeScriptでは number として扱うが、型レベルで区別する
 */
export type UdonFloat = number & { readonly __brand: "UdonFloat" };

/**
 * UdonSharp double型（C# double: 倍精度浮動小数点）
 * TypeScriptでは number として扱うが、型レベルで区別する
 */
export type UdonDouble = number & { readonly __brand: "UdonDouble" };

/**
 * UdonSharp long型（C# long: -9,223,372,036,854,775,808 to 9,223,372,036,854,775,807）
 * TypeScriptでは bigint として扱う
 */
export type UdonLong = bigint & { readonly __brand: "UdonLong" };

/**
 * UdonSharp ulong型（C# ulong: 0 to 18,446,744,073,709,551,615）
 * TypeScriptでは bigint として扱う
 * PackedSyncGameStateの要素型として使用
 */
export type UdonULong = bigint & { readonly __brand: "UdonULong" };

// =============================================================================
// 数値型変換ユーティリティ
// =============================================================================

export class UdonTypeConverters {
  /**
   * numberをUdonByteに変換（0-255にクランプ）
   */
  static toUdonByte(value: number): UdonByte {
    if (!Number.isFinite(value)) {
      return 0 as UdonByte;
    }
    const clamped = Math.floor(Math.max(0, Math.min(255, value)));
    return clamped as UdonByte;
  }

  /**
   * numberをUdonIntに変換（32bit整数範囲にクランプ）
   */
  static toUdonInt(value: number): UdonInt {
    if (!Number.isFinite(value)) {
      return 0 as UdonInt;
    }
    const clamped = Math.floor(
      Math.max(-2147483648, Math.min(2147483647, value)),
    );
    return clamped as UdonInt;
  }

  /**
   * numberをUdonFloatに変換
   */
  static toUdonFloat(value: number): UdonFloat {
    if (!Number.isFinite(value)) {
      return 0 as UdonFloat;
    }
    return Math.fround(value) as UdonFloat;
  }

  /**
   * numberをUdonDoubleに変換
   */
  static toUdonDouble(value: number): UdonDouble {
    if (!Number.isFinite(value)) {
      return 0 as UdonDouble;
    }
    return value as UdonDouble;
  }

  /**
   * bigintをUdonLongに変換（64bit符号付き整数範囲にクランプ）
   */
  static toUdonLong(value: bigint): UdonLong {
    const min = -9223372036854775808n;
    const max = 9223372036854775807n;
    const clamped = value < min ? min : value > max ? max : value;
    return clamped as UdonLong;
  }

  /**
   * bigintをUdonULongに変換（64bit符号なし整数範囲にクランプ）
   */
  static toUdonULong(value: bigint): UdonULong {
    const max = 18446744073709551615n; // 2^64 - 1
    const clamped = value < 0n ? 0n : value > max ? max : value;
    return clamped as UdonULong;
  }

  /**
   * numberからbigintに変換してUdonLongに（整数部分のみ）
   */
  static numberToUdonLong(value: number): UdonLong {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Cannot convert ${value} to UdonLong: value must be finite`,
      );
    }
    return UdonTypeConverters.toUdonLong(BigInt(Math.trunc(value)));
  }

  /**
   * numberからbigintに変換してUdonULongに（整数部分のみ、負数は0）
   */
  static numberToUdonULong(value: number): UdonULong {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Cannot convert ${value} to UdonULong: value must be finite`,
      );
    }
    return UdonTypeConverters.toUdonULong(
      BigInt(Math.max(0, Math.trunc(value))),
    );
  }
}

// =============================================================================
// UdonSharp Syncable型定義
// =============================================================================

/**
 * UdonSynced属性のマーカー型
 *
 * VRChatのUdonSharpでは、UdonSynced属性を付けた変数がネットワーク同期される。
 * この型はTypeScript側でその概念を表現するためのマーカー型。
 *
 * @example
 * ```typescript
 * // TypeScript側
 * private syncedState: UdonSynced;
 *
 * // 対応するUdonSharp (C#)
 * [UdonSynced] private ulong[] _syncedState;
 * ```
 */
export type UdonSynced = Syncable;

/**
 * UdonSharpで同期可能な型のユニオン
 *
 * VRChatのUdonSharpでは以下の型のみがネットワーク同期可能:
 * - プリミティブ: string, byte, int, long, ulong, float, double, bool
 * - 上記の配列
 *
 * 注意: ネストされたオブジェクトや複雑な型は直接同期できない。
 * PackedSyncGameStateのようにビットパッキングして同期する。
 */
export type Syncable = unknown;

/**
 * SendCustomNetworkEventのターゲット指定
 *
 * - "All": 全プレイヤーにイベントを送信
 * - "Owner": オブジェクトオーナーにのみ送信
 * - "Local": ローカル（自分自身）にのみ送信
 */
export type NetworkEventTarget = "All" | "Owner" | "Local";

/**
 * SendCustomNetworkEventで送信可能な引数型
 *
 * VRChatのSendCustomNetworkEventは引数を渡すことが可能。
 * 対応する型はUdonSharpの制約に従う。
 *
 * 注意: 複雑なオブジェクトは渡せないため、
 * シリアライズして文字列やbigint配列として送信する必要がある。
 */
export type UdonEventArg = unknown;

/**
 * Udonのプレイヤー同期モード（参照用）
 *
 * VRChatでは変数の同期方法を指定できる：
 * - None: 同期なし
 * - Linear: 位置など連続的な値の補間同期
 * - Smooth: より滑らかな補間同期
 */
export type UdonSyncMode = "None" | "Linear" | "Smooth";

/**
 * Udonオブジェクトの同期タイプ（参照用）
 *
 * - Continuous: 常に同期（位置・回転など）
 * - Manual: RequestSerializationで明示的に同期
 */
export type UdonSyncType = "Continuous" | "Manual";

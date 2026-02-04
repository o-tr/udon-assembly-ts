/**
 * 同期可能型のスタブ定義
 *
 * 互換レイヤーとしての型定義とガードのみを提供する。
 * 実ロジック（ビットパッキング等）は vrc/utils に移動。
 */

import type { UdonInt } from "./UdonTypes.js";

/**
 * パックされたゲーム状態（全体同期用）
 * - Udon側: `ulong[]`
 * - TS側: `bigint[]`
 */
export type PackedSyncGameState = bigint[];

/**
 * パックされた差分状態（差分同期用）
 * - Udon側: `ulong[]`
 * - TS側: `bigint[]`
 */
export type PackedSyncDelta = bigint[];

/**
 * タイルID（6ビット）
 */
export type TileId = UdonInt;

/**
 * 同期可能型のガード（互換用）
 */
export class SyncableTypeGuards {
  /**
   * 値がSyncable型かどうかを判定
   */
  static isSyncable(value: unknown): boolean {
    if (value === null || value === undefined) {
      return false;
    }

    const type = typeof value;

    // プリミティブ型
    if (
      type === "string" ||
      type === "number" ||
      type === "bigint" ||
      type === "boolean"
    ) {
      return true;
    }

    // 配列型
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return true;
      }
      const firstType = typeof value[0];
      return (
        firstType === "string" ||
        firstType === "number" ||
        firstType === "bigint" ||
        firstType === "boolean"
      );
    }

    // Uint8Array
    if (value instanceof Uint8Array) {
      return true;
    }

    return false;
  }

  /**
   * 値がPackedSyncGameStateかどうかを判定
   */
  static isPackedSyncGameState(value: unknown): value is PackedSyncGameState {
    if (!Array.isArray(value)) {
      return false;
    }
    for (const item of value) {
      if (typeof item !== "bigint") {
        return false;
      }
    }
    return true;
  }

  /**
   * 値がPackedSyncDeltaかどうかを判定
   */
  static isPackedSyncDelta(value: unknown): value is PackedSyncDelta {
    return SyncableTypeGuards.isPackedSyncGameState(value); // 同じ構造
  }
}

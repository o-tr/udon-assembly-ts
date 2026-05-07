import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

const ID_TO_STRING: string[] = [
  "1m",
  "2m",
  "3m",
  "4m",
  "5m",
  "6m",
  "7m",
  "8m",
  "9m",
  "1p",
  "2p",
  "3p",
  "4p",
  "5p",
  "6p",
  "7p",
  "8p",
  "9p",
  "1s",
  "2s",
  "3s",
  "4s",
  "5s",
  "6s",
  "7s",
  "8s",
  "9s",
  "1z",
  "2z",
  "3z",
  "4z",
  "5z",
  "6z",
  "7z",
  "0m",
  "0p",
  "0s",
];

class Tile {
  readonly kind: UdonInt;
  readonly code: UdonInt;
  readonly isRed: boolean;

  private constructor(kind: UdonInt, code: UdonInt, isRed: boolean) {
    this.kind = kind;
    this.code = code;
    this.isRed = isRed;
  }

  toString(): string {
    return ID_TO_STRING[Number(this.code)];
  }

  static parse(str: string): Tile {
    switch (str) {
      case "1m":
        return Tile.fromCode(0n as UdonInt);
      case "2m":
        return Tile.fromCode(1n as UdonInt);
      case "5m":
        return Tile.fromCode(4n as UdonInt);
      case "9m":
        return Tile.fromCode(8n as UdonInt);
      case "1z":
        return Tile.fromCode(27n as UdonInt);
      case "4z":
        return Tile.fromCode(30n as UdonInt);
      case "5z":
        return Tile.fromCode(31n as UdonInt);
      case "7z":
        return Tile.fromCode(33n as UdonInt);
      default:
        throw new Error(`Unsupported tile literal: ${str}`);
    }
  }

  static fromKind(kind: UdonInt, isRed?: boolean): Tile {
    const k = Number(kind);
    if (k < 0 || k > 33) {
      throw new Error(`Invalid TileKind: ${k}`);
    }
    if (isRed) {
      if (k !== 4 && k !== 13 && k !== 22) {
        throw new Error(`Only 5m/5p/5s can be red, got kind=${k}`);
      }
      return Tile._getInstances()[34 + ((k / 9) | 0)];
    }
    return Tile._getInstances()[k];
  }

  static fromCode(code: UdonInt): Tile {
    const c = Number(code);
    if (c < 0 || c > 36) {
      throw new Error(`Invalid TileCode: ${c}`);
    }
    return Tile._getInstances()[c];
  }

  private static _instances: Tile[] | null = null;

  private static _getInstances(): Tile[] {
    if (Tile._instances !== null) return Tile._instances;
    const instances: Tile[] = [];
    for (let i = 0; i < 34; i += 1) {
      instances.push(
        new Tile(BigInt(i) as UdonInt, BigInt(i) as UdonInt, false),
      );
    }
    for (let suitIdx = 0; suitIdx < 3; suitIdx += 1) {
      const kind = BigInt(suitIdx * 9 + 4) as UdonInt;
      instances.push(new Tile(kind, BigInt(34 + suitIdx) as UdonInt, true));
    }
    Tile._instances = instances;
    return instances;
  }

  static nextDoraKind(kind: UdonInt): UdonInt {
    if (kind < 27n) {
      return (kind % 9n === 8n ? kind - 8n : kind + 1n) as UdonInt;
    }
    if (kind <= 30n) {
      return (((kind - 27n + 1n) % 4n) + 27n) as UdonInt;
    }
    return (((kind - 31n + 1n) % 3n) + 31n) as UdonInt;
  }

  isDoraIndicatorFor(tile: Tile): boolean {
    return Tile.nextDoraKind(this.kind) === tile.kind;
  }
}

@UdonBehaviour()
export class MahjongTileDoraRegression extends UdonSharpBehaviour {
  Start(): void {
    Debug.Log(
      Tile.fromKind(Tile.nextDoraKind(Tile.parse("1m").kind)).toString(),
    );
    Debug.Log(
      Tile.fromKind(Tile.nextDoraKind(Tile.parse("9m").kind)).toString(),
    );
    Debug.Log(
      Tile.fromKind(Tile.nextDoraKind(Tile.parse("1z").kind)).toString(),
    );
    Debug.Log(
      Tile.fromKind(Tile.nextDoraKind(Tile.parse("4z").kind)).toString(),
    );
    Debug.Log(
      Tile.fromKind(Tile.nextDoraKind(Tile.parse("5z").kind)).toString(),
    );
    Debug.Log(
      Tile.fromKind(Tile.nextDoraKind(Tile.parse("7z").kind)).toString(),
    );
    Debug.Log(
      Tile.parse("1m").isDoraIndicatorFor(Tile.parse("2m")) ? "True" : "False",
    );
    Debug.Log(
      Tile.parse("1m").isDoraIndicatorFor(Tile.parse("5m")) ? "True" : "False",
    );
  }
}

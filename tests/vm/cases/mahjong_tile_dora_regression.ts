import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import {
  type UdonInt,
  UdonTypeConverters,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
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
    return ID_TO_STRING[this.code as number];
  }

  static parse(str: string): Tile {
    switch (str) {
      case "1m":
        return Tile.fromCode(UdonTypeConverters.toUdonInt(0));
      case "2m":
        return Tile.fromCode(UdonTypeConverters.toUdonInt(1));
      case "5m":
        return Tile.fromCode(UdonTypeConverters.toUdonInt(4));
      case "9m":
        return Tile.fromCode(UdonTypeConverters.toUdonInt(8));
      case "1z":
        return Tile.fromCode(UdonTypeConverters.toUdonInt(27));
      case "4z":
        return Tile.fromCode(UdonTypeConverters.toUdonInt(30));
      case "5z":
        return Tile.fromCode(UdonTypeConverters.toUdonInt(31));
      case "7z":
        return Tile.fromCode(UdonTypeConverters.toUdonInt(33));
      default:
        throw new Error(`Unsupported tile literal: ${str}`);
    }
  }

  static fromKind(kind: UdonInt, isRed?: boolean): Tile {
    const k = kind as number;
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
    const c = code as number;
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
        new Tile(
          UdonTypeConverters.toUdonInt(i),
          UdonTypeConverters.toUdonInt(i),
          false,
        ),
      );
    }
    for (let suitIdx = 0; suitIdx < 3; suitIdx += 1) {
      const kind = UdonTypeConverters.toUdonInt(suitIdx * 9 + 4);
      instances.push(
        new Tile(kind, UdonTypeConverters.toUdonInt(34 + suitIdx), true),
      );
    }
    Tile._instances = instances;
    return instances;
  }

  static nextDoraKind(kind: UdonInt): UdonInt {
    const k = kind as number;
    if (k < 27) {
      return UdonTypeConverters.toUdonInt(k % 9 === 8 ? k - 8 : k + 1);
    }
    if (k <= 30) {
      return UdonTypeConverters.toUdonInt(((k - 27 + 1) % 4) + 27);
    }
    return UdonTypeConverters.toUdonInt(((k - 31 + 1) % 3) + 31);
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

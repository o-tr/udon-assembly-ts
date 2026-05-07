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
      case "3p":
        return Tile.fromCode(11n as UdonInt);
      case "1s":
        return Tile.fromCode(18n as UdonInt);
      case "5s":
        return Tile.fromCode(22n as UdonInt);
      case "9s":
        return Tile.fromCode(26n as UdonInt);
      default:
        throw new Error(`Unsupported tile literal: ${str}`);
    }
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
        new Tile(
          BigInt(i) as UdonInt,
          BigInt(i) as UdonInt,
          false,
        ),
      );
    }
    for (let suitIdx = 0; suitIdx < 3; suitIdx += 1) {
      const kind = BigInt(suitIdx * 9 + 4) as UdonInt;
      instances.push(
        new Tile(kind, BigInt(34 + suitIdx) as UdonInt, true),
      );
    }
    Tile._instances = instances;
    return instances;
  }

  static compare(a: Tile, b: Tile): UdonInt {
    const kindDiff = Number(a.kind) - Number(b.kind);
    if (kindDiff !== 0) return BigInt(kindDiff) as UdonInt;
    if (a.isRed === b.isRed) return 0n as UdonInt;
    return a.isRed ? (-1n as UdonInt) : (1n as UdonInt);
  }

  static sortTiles(tiles: readonly Tile[]): Tile[] {
    const result = [...tiles];
    for (let i = 1; i < result.length; i += 1) {
      const current = result[i];
      let j = i - 1;
      while (j >= 0 && Tile.compare(result[j], current) > 0) {
        result[j + 1] = result[j];
        j -= 1;
      }
      result[j + 1] = current;
    }
    return result;
  }

  static sortThreeTiles(tiles: Tile[]): Tile[] {
    let a = tiles[0];
    let b = tiles[1];
    let c = tiles[2];
    let t: Tile;
    if (Tile.compare(a, b) > 0) {
      t = a;
      a = b;
      b = t;
    }
    if (Tile.compare(b, c) > 0) {
      t = b;
      b = c;
      c = t;
    }
    if (Tile.compare(a, b) > 0) {
      t = a;
      a = b;
      b = t;
    }
    return [a, b, c];
  }
}

@UdonBehaviour()
export class MahjongTileSortCompareRegression extends UdonSharpBehaviour {
  Start(): void {
    const cmp1 = Tile.compare(Tile.parse("1m"), Tile.parse("2m"));
    Debug.Log(cmp1 < 0 ? "LT" : "GE");

    const cmp2 = Tile.compare(Tile.parse("2m"), Tile.parse("1m"));
    Debug.Log(cmp2 > 0 ? "GT" : "LE");

    const cmp3 = Tile.compare(Tile.parse("5m"), Tile.parse("5m"));
    Debug.Log(cmp3 === (0n as UdonInt) ? "EQ" : "NE");

    const sorted = Tile.sortTiles([
      Tile.parse("9m"),
      Tile.parse("1m"),
      Tile.parse("5m"),
    ]);
    Debug.Log(sorted[0].toString());
    Debug.Log(sorted[1].toString());
    Debug.Log(sorted[2].toString());

    const sorted2 = Tile.sortTiles([
      Tile.parse("5s"),
      Tile.parse("1m"),
      Tile.parse("3p"),
    ]);
    Debug.Log(sorted2[0].toString());
    Debug.Log(sorted2[1].toString());
    Debug.Log(sorted2[2].toString());

    const sorted3 = Tile.sortThreeTiles([
      Tile.parse("9s"),
      Tile.parse("1s"),
      Tile.parse("5s"),
    ]);
    Debug.Log(sorted3[0].toString());
    Debug.Log(sorted3[1].toString());
    Debug.Log(sorted3[2].toString());
  }
}

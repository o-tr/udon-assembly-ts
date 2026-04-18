import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import {
  type UdonInt,
  UdonTypeConverters,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Tile {
  readonly kind: UdonInt;

  private constructor(kind: UdonInt) {
    this.kind = kind;
  }

  private static _instances: Tile[] | null = null;

  private static _getInstances(): Tile[] {
    if (Tile._instances !== null) return Tile._instances;
    const instances: Tile[] = [];
    for (let i = 0; i < 10; i += 1) {
      instances.push(new Tile(UdonTypeConverters.toUdonInt(i)));
    }
    Tile._instances = instances;
    return instances;
  }

  static get(idx: UdonInt): Tile {
    return Tile._getInstances()[idx as number];
  }
}

class Hand {
  private _tiles: Tile[];

  constructor(tiles: Tile[]) {
    this._tiles = tiles;
  }

  get tiles(): Tile[] {
    return this._tiles;
  }
}

@UdonBehaviour()
export class HandGetterOnly extends UdonSharpBehaviour {
  Start(): void {
    const hand = new Hand([
      Tile.get(UdonTypeConverters.toUdonInt(2)),
      Tile.get(UdonTypeConverters.toUdonInt(3)),
      Tile.get(UdonTypeConverters.toUdonInt(5)),
    ]);
    Debug.Log(hand.tiles[0].kind as number);
    Debug.Log(hand.tiles.length);
  }
}

import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import {
  type UdonInt,
  UdonTypeConverters,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Tile {
  readonly kind: UdonInt;

  constructor(kind: UdonInt) {
    this.kind = kind;
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
export class GetterForOf extends UdonSharpBehaviour {
  Start(): void {
    const hand = new Hand([
      new Tile(UdonTypeConverters.toUdonInt(2)),
      new Tile(UdonTypeConverters.toUdonInt(3)),
      new Tile(UdonTypeConverters.toUdonInt(5)),
    ]);
    let sum = 0;
    for (const tile of hand.tiles) {
      sum += tile.kind as number;
    }
    Debug.Log(sum);
  }
}

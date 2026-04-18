import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import {
  type UdonInt,
  UdonTypeConverters,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Tile {
  readonly kind: UdonInt;
  readonly code: UdonInt;
  constructor(kind: UdonInt, code: UdonInt) {
    this.kind = kind;
    this.code = code;
  }
}

class Hand {
  readonly tiles: Tile[];
  constructor(tiles: Tile[]) {
    this.tiles = tiles;
  }
}

@UdonBehaviour()
export class HandTileKindReadback extends UdonSharpBehaviour {
  Start(): void {
    const t0 = new Tile(
      UdonTypeConverters.toUdonInt(0),
      UdonTypeConverters.toUdonInt(0),
    );
    const t1 = new Tile(
      UdonTypeConverters.toUdonInt(1),
      UdonTypeConverters.toUdonInt(1),
    );
    const hand = new Hand([t0, t1]);
    Debug.Log(hand.tiles[0].kind as number);
    Debug.Log(hand.tiles[1].kind as number);
  }
}

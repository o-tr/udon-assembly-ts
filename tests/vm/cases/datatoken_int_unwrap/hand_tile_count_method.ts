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
  readonly tiles: Tile[];
  constructor(tiles: Tile[]) {
    this.tiles = tiles;
  }
  tileCount(): UdonInt {
    return UdonTypeConverters.toUdonInt(this.tiles.length);
  }
  firstKind(): UdonInt {
    return this.tiles[0].kind;
  }
}

@UdonBehaviour()
export class HandTileCountMethod extends UdonSharpBehaviour {
  Start(): void {
    const hand = new Hand([
      new Tile(UdonTypeConverters.toUdonInt(3)),
      new Tile(UdonTypeConverters.toUdonInt(7)),
      new Tile(UdonTypeConverters.toUdonInt(12)),
    ]);
    Debug.Log(hand.tileCount() as number);
    Debug.Log(hand.firstKind() as number);
  }
}

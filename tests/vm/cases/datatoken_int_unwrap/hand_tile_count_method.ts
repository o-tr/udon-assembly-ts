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
    return BigInt(this.tiles.length) as UdonInt;
  }
  firstKind(): UdonInt {
    return this.tiles[0].kind;
  }
}

@UdonBehaviour()
export class HandTileCountMethod extends UdonSharpBehaviour {
  Start(): void {
    const hand = new Hand([
      new Tile(3n as UdonInt),
      new Tile(7n as UdonInt),
      new Tile(12n as UdonInt),
    ]);
    Debug.Log(Number(hand.tileCount()));
    Debug.Log(Number(hand.firstKind()));
  }
}

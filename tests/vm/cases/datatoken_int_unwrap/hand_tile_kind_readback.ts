import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
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
    const t0 = new Tile(0n as UdonInt, 0n as UdonInt);
    const t1 = new Tile(1n as UdonInt, 1n as UdonInt);
    const hand = new Hand([t0, t1]);
    Debug.Log(Number(hand.tiles[0].kind));
    Debug.Log(Number(hand.tiles[1].kind));
  }
}

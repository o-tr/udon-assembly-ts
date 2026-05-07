import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
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
      instances.push(new Tile(BigInt(i) as UdonInt));
    }
    Tile._instances = instances;
    return instances;
  }

  static get(idx: UdonInt): Tile {
    return Tile._getInstances()[Number(idx)];
  }
}

class Hand {
  private _tiles: Tile[];

  constructor(tiles: readonly Tile[]) {
    this._tiles = [...tiles];
  }

  get tiles(): readonly Tile[] {
    return this._tiles;
  }
}

@UdonBehaviour()
export class HandPrivateFieldGetter extends UdonSharpBehaviour {
  Start(): void {
    const hand = new Hand([
      Tile.get(2n as UdonInt),
      Tile.get(3n as UdonInt),
      Tile.get(5n as UdonInt),
    ]);
    Debug.Log(Number(hand.tiles[0].kind));
    Debug.Log(hand.tiles.length);
  }
}

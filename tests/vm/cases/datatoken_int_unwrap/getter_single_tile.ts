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

class Holder {
  private _tile: Tile;

  constructor(tile: Tile) {
    this._tile = tile;
  }

  get tile(): Tile {
    return this._tile;
  }
}

@UdonBehaviour()
export class GetterSingleTile extends UdonSharpBehaviour {
  Start(): void {
    const holder = new Holder(new Tile(UdonTypeConverters.toUdonInt(7)));
    Debug.Log(holder.tile.kind as number);
  }
}

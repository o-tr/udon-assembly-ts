import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Tile {
  readonly kind: UdonInt;

  constructor(kind: UdonInt) {
    this.kind = kind;
  }

  static compare(a: Tile, b: Tile): UdonInt {
    return (a.kind - b.kind) as UdonInt;
  }
}

@UdonBehaviour()
export class TileSortCompare extends UdonSharpBehaviour {
  Start(): void {
    const cmp1 = Tile.compare(new Tile(1n as UdonInt), new Tile(2n as UdonInt));
    Debug.Log(cmp1 < (0n as UdonInt) ? "LT" : "GE");

    const cmp2 = Tile.compare(new Tile(2n as UdonInt), new Tile(1n as UdonInt));
    Debug.Log(cmp2 > (0n as UdonInt) ? "GT" : "LE");

    const cmp3 = Tile.compare(new Tile(5n as UdonInt), new Tile(5n as UdonInt));
    Debug.Log(cmp3 === (0n as UdonInt) ? "EQ" : "NE");

    // Also assert <= / >= branches on the same compare values.
    Debug.Log(cmp1 <= (0n as UdonInt) ? "LE" : "GT");
    Debug.Log(cmp2 >= (0n as UdonInt) ? "GE" : "LT");
  }
}

import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { UdonTypeConverters } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Tile {
  readonly kind: UdonInt;

  constructor(kind: UdonInt) {
    this.kind = kind;
  }

  static compare(a: Tile, b: Tile): UdonInt {
    const kindDiff = (a.kind as number) - (b.kind as number);
    return UdonTypeConverters.toUdonInt(kindDiff);
  }
}

@UdonBehaviour()
export class TileSortCompare extends UdonSharpBehaviour {
  Start(): void {
    const cmp1 = Tile.compare(new Tile(1 as UdonInt), new Tile(2 as UdonInt));
    Debug.Log(cmp1 < (0 as UdonInt) ? "LT" : "GE");

    const cmp2 = Tile.compare(new Tile(2 as UdonInt), new Tile(1 as UdonInt));
    Debug.Log(cmp2 > (0 as UdonInt) ? "GT" : "LE");

    const cmp3 = Tile.compare(new Tile(5 as UdonInt), new Tile(5 as UdonInt));
    Debug.Log(cmp3 === (0 as UdonInt) ? "EQ" : "NE");

    // Also assert <= / >= branches on the same compare values.
    Debug.Log(cmp1 <= (0 as UdonInt) ? "LE" : "GT");
    Debug.Log(cmp2 >= (0 as UdonInt) ? "GE" : "LT");
  }
}

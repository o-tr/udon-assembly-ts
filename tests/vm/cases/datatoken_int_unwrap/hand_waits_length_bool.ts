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

class TenpaiResult {
  readonly waits: Tile[];
  readonly isTenpai: boolean;
  constructor(waits: Tile[], isTenpai: boolean) {
    this.waits = waits;
    this.isTenpai = isTenpai;
  }
}

@UdonBehaviour()
export class HandWaitsLengthBool extends UdonSharpBehaviour {
  Start(): void {
    const r = new TenpaiResult(
      [
        new Tile(UdonTypeConverters.toUdonInt(5)),
        new Tile(UdonTypeConverters.toUdonInt(8)),
      ],
      true,
    );
    Debug.Log(r.isTenpai ? "True" : "False");
    Debug.Log(r.waits.length);
    Debug.Log(r.waits[0].kind as number);
  }
}

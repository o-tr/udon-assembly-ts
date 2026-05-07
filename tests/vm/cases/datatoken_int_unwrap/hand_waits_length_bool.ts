import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
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
      [new Tile(5n as UdonInt), new Tile(8n as UdonInt)],
      true,
    );
    Debug.Log(r.isTenpai ? "True" : "False");
    Debug.Log(r.waits.length);
    Debug.Log(Number(r.waits[0].kind));
  }
}

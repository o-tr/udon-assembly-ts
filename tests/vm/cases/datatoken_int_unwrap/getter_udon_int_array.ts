import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import {
  type UdonInt,
  UdonTypeConverters,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Container {
  private _values: UdonInt[];

  constructor(values: UdonInt[]) {
    this._values = values;
  }

  get values(): UdonInt[] {
    return this._values;
  }
}

@UdonBehaviour()
export class GetterUdonIntArray extends UdonSharpBehaviour {
  Start(): void {
    const c = new Container([
      2n as UdonInt,
      3n as UdonInt,
      5n as UdonInt,
    ]);
    Debug.Log(Number(c.values[0]));
    Debug.Log(c.values.length);
  }
}

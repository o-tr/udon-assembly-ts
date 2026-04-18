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
      UdonTypeConverters.toUdonInt(2),
      UdonTypeConverters.toUdonInt(3),
      UdonTypeConverters.toUdonInt(5),
    ]);
    Debug.Log(c.values[0] as number);
    Debug.Log(c.values.length);
  }
}

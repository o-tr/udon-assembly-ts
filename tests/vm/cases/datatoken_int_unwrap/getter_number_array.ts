import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Container {
  private _values: number[];

  constructor(values: number[]) {
    this._values = values;
  }

  get values(): number[] {
    return this._values;
  }
}

@UdonBehaviour()
export class GetterNumberArray extends UdonSharpBehaviour {
  Start(): void {
    const c = new Container([1.5, 2.5, 3.5]);
    Debug.Log(c.values[0]);
    Debug.Log(c.values.length);
  }
}

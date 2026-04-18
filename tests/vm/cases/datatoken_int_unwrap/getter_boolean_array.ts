import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Container {
  private _flags: boolean[];

  constructor(flags: boolean[]) {
    this._flags = flags;
  }

  get flags(): boolean[] {
    return this._flags;
  }
}

@UdonBehaviour()
export class GetterBooleanArray extends UdonSharpBehaviour {
  Start(): void {
    const c = new Container([true, false, true]);
    Debug.Log(c.flags[0] ? "True" : "False");
    Debug.Log(c.flags.length);
  }
}

import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class OperatorsArithmetic extends UdonSharpBehaviour {
  Start(): void {
    let mod: number = 17 % 5;
    Debug.Log(mod);
    let x: number = 10;
    x = x + 5;
    Debug.Log(x);
    x = x - 3;
    Debug.Log(x);
    x = x * 2;
    Debug.Log(x);
    let neg: number = 0 - x;
    Debug.Log(neg);
  }
}

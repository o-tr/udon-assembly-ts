import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TypeCoercionStringNumber extends UdonSharpBehaviour {
  Start(): void {
    const num: number = 42;
    Debug.Log(num);
    const msg: string = "The answer is " + num;
    Debug.Log(msg);
    const big: number = 100;
    Debug.Log(big);
  }
}

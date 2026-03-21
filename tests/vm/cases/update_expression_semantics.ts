import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class UpdateExpressionSemantics extends UdonSharpBehaviour {
  Start(): void {
    let x: number = 5;
    const postfix: number = x++;
    Debug.Log(postfix);
    Debug.Log(x);

    x = 5;
    const prefix: number = ++x;
    Debug.Log(prefix);
    Debug.Log(x);

    let y: number = 10;
    const mixed: number = y++ + 1;
    Debug.Log(mixed);
    Debug.Log(y);
  }
}
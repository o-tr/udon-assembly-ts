import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class UpdateStatementEffect extends UdonSharpBehaviour {
  Start(): void {
    let x: number = 0;
    x++;
    x++;
    Debug.Log(x);
    x--;
    Debug.Log(x);
  }
}
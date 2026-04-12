import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ForLoopAccumulateFloatTest extends UdonSharpBehaviour {
  Start(): void {
    let sum = 0.0;
    for (let i = 0; i < 4; i++) {
      sum += i * 0.5;
    }
    Debug.Log(sum);
  }
}

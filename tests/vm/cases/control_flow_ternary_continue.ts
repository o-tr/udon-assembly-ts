import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ControlFlowTernaryContinue extends UdonSharpBehaviour {
  Start(): void {
    let score = 0;
    for (let i = 0; i < 6; i++) {
      const add = i % 2 === 0 ? i : -1;
      if (add < 0) {
        continue;
      }
      score += add;
    }

    Debug.Log(score);
  }
}

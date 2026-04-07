import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Score {
  constructor(public value: UdonInt) {}

  add(delta: UdonInt): Score {
    return new Score((this.value + delta) as UdonInt);
  }
}

@UdonBehaviour()
export class ScoreArithmeticRegression extends UdonSharpBehaviour {
  Start(): void {
    const s = new Score(25000 as UdonInt);
    const s2 = s.add(1000 as UdonInt);
    Debug.Log(s.value);
    Debug.Log(s2.value);
  }
}


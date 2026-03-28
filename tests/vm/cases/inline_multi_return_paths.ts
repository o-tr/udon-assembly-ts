import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

// Verifies that returnInstancePrefix stable-prefix normalizes className so that
// multiple return paths through a method all unify to the same interface name.

type Status = { code: number; label: string };

class Checker {
  static evaluate(x: number): Status {
    if (x > 0) {
      return { code: 1, label: "positive" };
    }
    if (x < 0) {
      return { code: -1, label: "negative" };
    }
    return { code: 0, label: "zero" };
  }
}

@UdonBehaviour()
export class InlineMultiReturnPaths extends UdonSharpBehaviour {
  Start(): void {
    const a = Checker.evaluate(5);
    Debug.Log(a.code); // 1
    Debug.Log(a.label); // positive

    const b = Checker.evaluate(-3);
    Debug.Log(b.code); // -1
    Debug.Log(b.label); // negative

    const c = Checker.evaluate(0);
    Debug.Log(c.code); // 0
    Debug.Log(c.label); // zero
  }
}

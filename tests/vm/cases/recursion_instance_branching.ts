import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Counter {
  branch(n: number): number {
    if (n <= 1) {
      return 1;
    }
    return this.branch(n - 1) + this.branch(n - 2);
  }
}

@UdonBehaviour()
export class RecursionInstanceBranching extends UdonSharpBehaviour {
  Start(): void {
    const c: Counter = new Counter();
    Debug.Log(c.branch(4));
    Debug.Log(c.branch(5));
  }
}

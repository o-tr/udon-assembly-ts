import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class RunningTotal {
  value: number = 0;

  addAndGet(n: number): number {
    this.value = this.value + n;
    return this.value;
  }
}

@UdonBehaviour()
export class InlineStateReadAfterWrite extends UdonSharpBehaviour {
  private total: RunningTotal = new RunningTotal();

  Start(): void {
    Debug.Log(this.total.addAndGet(5));
    Debug.Log(this.total.addAndGet(10));
    Debug.Log(this.total.addAndGet(5));
  }
}

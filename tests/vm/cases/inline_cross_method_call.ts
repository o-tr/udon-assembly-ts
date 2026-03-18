import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Accumulator {
  value: number = 0;

  add(n: number): void {
    this.value = this.value + n;
  }

  addDouble(n: number): void {
    this.add(n * 2);
  }
}

@UdonBehaviour()
export class InlineCrossMethodCall extends UdonSharpBehaviour {
  private acc: Accumulator = new Accumulator();

  Start(): void {
    this.acc.add(5);
    this.acc.addDouble(5);
    Debug.Log(this.acc.value);
    this.acc.addDouble(5);
    Debug.Log(this.acc.value);
  }
}

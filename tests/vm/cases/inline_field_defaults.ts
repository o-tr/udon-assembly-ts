import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Accumulator {
  value: number = 5;

  add(n: number): void {
    this.value = this.value + n;
  }

  getValue(): number {
    return this.value;
  }
}

@UdonBehaviour()
export class InlineFieldDefaults extends UdonSharpBehaviour {
  private acc: Accumulator = new Accumulator();

  Start(): void {
    // Default value should be 5, not 0
    Debug.Log(this.acc.getValue()); // 5

    this.acc.add(10);
    Debug.Log(this.acc.getValue()); // 15

    this.acc.add(5);
    Debug.Log(this.acc.getValue()); // 20
  }
}

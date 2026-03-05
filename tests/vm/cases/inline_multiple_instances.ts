import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Adder {
  value: number = 0;

  add(n: number): void {
    this.value = this.value + n;
  }

  getValue(): number {
    return this.value;
  }
}

@UdonBehaviour()
export class InlineMultipleInstances extends UdonSharpBehaviour {
  private adder1: Adder = new Adder();
  private adder2: Adder = new Adder();

  Start(): void {
    this.adder1.add(15);
    Debug.Log(this.adder1.getValue());
    this.adder2.add(20);
    Debug.Log(this.adder2.getValue());
  }
}

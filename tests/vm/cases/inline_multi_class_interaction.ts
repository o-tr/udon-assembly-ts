import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Counter {
  value: number = 0;

  add(n: number): void {
    this.value = this.value + n;
  }

  getValue(): number {
    return this.value;
  }
}

class Multiplier {
  value: number = 1;

  multiply(n: number): void {
    this.value = this.value * n;
  }

  getValue(): number {
    return this.value;
  }
}

@UdonBehaviour()
export class InlineMultiClassInteraction extends UdonSharpBehaviour {
  private counter: Counter = new Counter();
  private multiplier: Multiplier = new Multiplier();

  Start(): void {
    // Use counter
    this.counter.add(3);
    this.counter.add(2);
    Debug.Log(this.counter.getValue()); // 5

    // Use multiplier (same property name 'value' must be independent)
    this.multiplier.multiply(4);
    this.multiplier.multiply(3);
    Debug.Log(this.multiplier.getValue()); // 12

    // Verify counter is still intact
    Debug.Log(this.counter.getValue()); // 5
  }
}

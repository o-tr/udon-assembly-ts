import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Counter {
  count: number = 0;

  increment(): void {
    this.count = this.count + 1;
  }

  getCount(): number {
    return this.count;
  }
}

@UdonBehaviour()
export class InlineBasic extends UdonSharpBehaviour {
  private counter: Counter = new Counter();

  Start(): void {
    this.counter.increment();
    this.counter.increment();
    this.counter.increment();
    Debug.Log(this.counter.getCount());
  }
}

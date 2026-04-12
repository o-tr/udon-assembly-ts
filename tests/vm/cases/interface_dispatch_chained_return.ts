import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

interface Counter {
  next(): Counter;
  getValue(): number;
}

class StepCounter implements Counter {
  private value: number;

  constructor(value: number) {
    this.value = value;
  }

  next(): Counter {
    return new StepCounter(this.value + 1);
  }

  getValue(): number {
    return this.value;
  }
}

class DoubleStepCounter implements Counter {
  private value: number;

  constructor(value: number) {
    this.value = value;
  }

  next(): Counter {
    return new DoubleStepCounter(this.value + 2);
  }

  getValue(): number {
    return this.value;
  }
}

@UdonBehaviour()
export class InterfaceDispatchChainedReturn extends UdonSharpBehaviour {
  Start(): void {
    const first: Counter = new StepCounter(1);
    const second = first.next().next();

    const third: Counter = new DoubleStepCounter(2);
    const fourth = third.next().next();

    Debug.Log(second.getValue());
    Debug.Log(fourth.getValue());
  }
}

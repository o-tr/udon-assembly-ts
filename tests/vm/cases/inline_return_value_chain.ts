import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Doubler {
  compute(x: number): number {
    return x * 2;
  }
}

class Adder {
  process(x: number): number {
    return x + 10;
  }
}

@UdonBehaviour()
export class InlineReturnValueChain extends UdonSharpBehaviour {
  private doubler: Doubler = new Doubler();
  private adder: Adder = new Adder();

  Start(): void {
    // Chain: doubler.compute(5) = 10, then adder.process(10) = 20
    const result: number = this.adder.process(this.doubler.compute(5));
    Debug.Log(result); // 20

    // Reverse chain: adder.process(3) = 13, then doubler.compute(13) = 26
    const result2: number = this.doubler.compute(this.adder.process(3));
    Debug.Log(result2); // 26
  }
}

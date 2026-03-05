import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Calculator {
  value: number = 0;

  add(n: number): void {
    this.value = this.value + n;
  }

  double(): void {
    this.value = this.value * 2;
  }

  addAndDouble(n: number): void {
    this.add(n);
    this.double();
  }

  getValue(): number {
    return this.value;
  }
}

@UdonBehaviour()
export class InlineMethodChain extends UdonSharpBehaviour {
  private calc: Calculator = new Calculator();

  Start(): void {
    this.calc.addAndDouble(5);
    Debug.Log(this.calc.getValue());
    this.calc.add(3);
    Debug.Log(this.calc.getValue());
  }
}

import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

interface ICalculator {
  add(a: number, b: number): number;
  getLabel(): string;
}

class SimpleCalculator implements ICalculator {
  add(a: number, b: number): number {
    return a + b;
  }

  getLabel(): string {
    return "simple";
  }
}

class DoubleCalculator implements ICalculator {
  add(a: number, b: number): number {
    return (a + b) * 2;
  }

  getLabel(): string {
    return "double";
  }
}

@UdonBehaviour()
export class InterfaceInlineDispatch extends UdonSharpBehaviour {
  private calc1: ICalculator = new SimpleCalculator();
  private calc2: ICalculator = new DoubleCalculator();

  Start(): void {
    Debug.Log(this.calc1.add(3, 4));
    Debug.Log(this.calc2.add(3, 4));
    Debug.Log(this.calc1.getLabel());
    Debug.Log(this.calc2.getLabel());
  }
}

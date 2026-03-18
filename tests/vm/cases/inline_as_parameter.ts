import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Box {
  value: number = 0;

  constructor(v: number) {
    this.value = v;
  }

  getValue(): number {
    return this.value;
  }
}

@UdonBehaviour()
export class InlineAsParameter extends UdonSharpBehaviour {
  private box: Box = new Box(42);

  readBox(b: Box): number {
    return b.getValue();
  }

  Start(): void {
    Debug.Log(this.readBox(this.box));
  }
}

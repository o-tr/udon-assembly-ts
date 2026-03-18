import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Wrapper {
  value: string = "";

  constructor(v: string) {
    this.value = v;
  }

  getValue(): string {
    return this.value;
  }
}

@UdonBehaviour()
export class OptionalChaining extends UdonSharpBehaviour {
  private wrapper: Wrapper = new Wrapper("hello");

  Start(): void {
    const result: string = this.wrapper?.getValue() ?? "default";
    Debug.Log(result);
    const nullStr: string = (null as unknown as string) ?? "fallback";
    Debug.Log(nullStr);
  }
}

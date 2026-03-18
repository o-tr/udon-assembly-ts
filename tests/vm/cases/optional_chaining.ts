import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class OptionalChaining extends UdonSharpBehaviour {
  getNonNull(): string | null {
    return "hello";
  }

  getNullable(): string | null {
    return null;
  }

  Start(): void {
    // Test ?? where left side is non-null (getNonNull() returns "hello")
    const result: string = this.getNonNull() ?? "default";
    Debug.Log(result);
    // Test ?? where left side is null
    const nullStr: string = this.getNullable() ?? "fallback";
    Debug.Log(nullStr);
  }
}

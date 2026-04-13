import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NullCoalescingStringTest extends UdonSharpBehaviour {
  private getNullable(): string | null {
    return null;
  }

  private getPresent(): string | null {
    return "ready";
  }

  Start(): void {
    const first: string = this.getNullable() ?? "fallback";
    const second: string = this.getPresent() ?? "fallback";
    Debug.Log(first);
    Debug.Log(second);
  }
}

import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class OptionalChainingMethodCall extends UdonSharpBehaviour {
  private getNullableText(): string | null {
    return null;
  }

  private getPresentText(): string | null {
    return "filled";
  }

  Start(): void {
    const firstText = this.getPresentText();
    const secondText = this.getNullableText();

    const first = firstText?.toString() ?? "empty";
    const second = secondText?.toString() ?? "empty";

    Debug.Log(first);
    Debug.Log(second);
  }
}

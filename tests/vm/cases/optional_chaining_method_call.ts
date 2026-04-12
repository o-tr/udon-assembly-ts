import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class OptionalChainingMethodCall extends UdonSharpBehaviour {
  Start(): void {
    const firstText: string | null = "filled";
    const secondText: string | null = null;

    const first = firstText?.toString() ?? "empty";
    const second = secondText?.toString() ?? "empty";

    Debug.Log(first);
    Debug.Log(second);
  }
}

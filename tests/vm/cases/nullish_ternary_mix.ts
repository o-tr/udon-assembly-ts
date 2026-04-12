import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NullishTernaryMix extends UdonSharpBehaviour {
  private getNull(): string | null {
    return null;
  }

  Start(): void {
    const fallback = "ok";
    const selected = this.getNull() ?? fallback;
    const result = selected === "ok" ? "hit" : "miss";

    Debug.Log(selected);
    Debug.Log(result);
  }
}

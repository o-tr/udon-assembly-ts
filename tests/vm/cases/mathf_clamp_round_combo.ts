import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonFloat } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug, Mathf } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class MathfClampRoundCombo extends UdonSharpBehaviour {
  Start(): void {
    const clamped = Mathf.Clamp(
      12 as UdonFloat,
      0 as UdonFloat,
      10 as UdonFloat,
    );
    const rounded = Mathf.RoundToInt(2.5 as UdonFloat);
    const ceiled = Mathf.CeilToInt(3.1 as UdonFloat);

    Debug.Log(clamped);
    Debug.Log(rounded);
    Debug.Log(ceiled);
  }
}

import { Convert } from "@ootr/udon-assembly-ts/stubs/SystemTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type {
  UdonFloat,
  UdonInt,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ConvertOverload extends UdonSharpBehaviour {
  Start(): void {
    // Convert.ToInt32 with UdonFloat argument
    const floatVal: UdonFloat = 3.7 as UdonFloat;
    const intFromFloat: UdonInt = Convert.ToInt32(floatVal);
    Debug.Log(intFromFloat); // 4 (Convert rounds, not truncates)

    // Convert.ToInt32 with UdonInt argument (identity)
    const intVal: UdonInt = 42 as UdonInt;
    const intFromInt: UdonInt = Convert.ToInt32(intVal);
    Debug.Log(intFromInt); // 42

    // Convert.ToSingle with UdonInt argument
    const floatFromInt: UdonFloat = Convert.ToSingle(intVal);
    Debug.Log(floatFromInt); // 42
  }
}

import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type {
  UdonFloat,
  UdonInt,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NumericTypePromotion extends UdonSharpBehaviour {
  Start(): void {
    // Int + Single → promoted to Single, but result stored as Int32 (truncated)
    // This verifies the promotion and conversion pipeline works
    const intVal: UdonInt = 10 as UdonInt;
    const floatVal: number = 3.5;
    const sumTruncated: UdonInt = (intVal + floatVal) as UdonInt;
    Debug.Log(sumTruncated); // 13 (promoted to Single for op, converted back to Int32)

    // Int * Single → product stored as explicit UdonFloat keeps decimal
    const product: UdonFloat = (intVal * floatVal) as UdonFloat;
    Debug.Log(product); // 35

    // Int < Single → comparison returns Boolean after promotion
    const less: boolean = intVal < floatVal;
    Debug.Log(less); // False (10 < 3.5 is false)

    // Int > Single → comparison
    const greater: boolean = intVal > floatVal;
    Debug.Log(greater); // True (10 > 3.5 is true)

    // Verify UdonInt arithmetic stays integer
    const a: UdonInt = 7 as UdonInt;
    const b: UdonInt = 2 as UdonInt;
    const intDiv: UdonInt = (a / b) as UdonInt;
    Debug.Log(intDiv); // 3 (integer division)
  }
}

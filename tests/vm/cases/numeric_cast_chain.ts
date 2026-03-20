import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type {
  UdonFloat,
  UdonInt,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NumericCastChain extends UdonSharpBehaviour {
  Start(): void {
    // float -> int (truncation)
    const a: number = 3.7;
    const intA: UdonInt = a as UdonInt;
    Debug.Log(intA); // 3

    // float -> int -> float (round-trip loses decimal)
    // @ts-expect-error UdonInt→UdonFloat is a runtime numeric cast in the transpiler
    const backToFloat: UdonFloat = intA as UdonFloat;
    Debug.Log(backToFloat); // 3

    // Another truncation
    const b: number = 7.9;
    const intB: UdonInt = b as UdonInt;
    Debug.Log(intB); // 7

    // int arithmetic then cast to float
    const intC: UdonInt = 15 as UdonInt;
    const intD: UdonInt = 2 as UdonInt;
    // @ts-expect-error UdonInt→UdonFloat casts are runtime numeric conversions in the transpiler
    const floatResult: UdonFloat = (intC as UdonFloat) / (intD as UdonFloat);
    Debug.Log(floatResult); // 7.5
  }
}

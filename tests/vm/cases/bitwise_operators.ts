import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class BitwiseOperators extends UdonSharpBehaviour {
  Start(): void {
    const a: UdonInt = 255 as UdonInt; // 0xFF
    const b: UdonInt = 15 as UdonInt; // 0x0F

    // Bitwise AND
    const andResult: UdonInt = (a & b) as UdonInt;
    Debug.Log(andResult); // 15

    // Bitwise OR
    const c: UdonInt = 240 as UdonInt; // 0xF0
    const orResult: UdonInt = (c | b) as UdonInt;
    Debug.Log(orResult); // 255

    // Bitwise XOR
    const xorResult: UdonInt = (a ^ b) as UdonInt;
    Debug.Log(xorResult); // 240

    // Combine operations: (a & 0x0F) | (a & 0xF0)
    const low: UdonInt = (a & b) as UdonInt;
    const high: UdonInt = (a & c) as UdonInt;
    const combined: UdonInt = (low | high) as UdonInt;
    Debug.Log(combined); // 255
  }
}

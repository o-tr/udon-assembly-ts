import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class CompoundAssignmentOperators extends UdonSharpBehaviour {
  Start(): void {
    // += on number (Single)
    let x: number = 10;
    x += 5;
    Debug.Log(x); // 15

    // -= on number
    x -= 3;
    Debug.Log(x); // 12

    // *= on number
    x *= 2;
    Debug.Log(x); // 24

    // /= on number
    x /= 4;
    Debug.Log(x); // 6

    // %= on number
    let y: number = 17;
    y %= 5;
    Debug.Log(y); // 2

    // += with float values
    let fsum: number = 0;
    fsum += 1.5;
    fsum += 2.5;
    fsum += 3.5;
    Debug.Log(fsum); // 7.5

    // += accumulation in loop
    let acc: number = 0;
    let i: number = 1;
    while (i <= 5) {
      acc += i;
      i = i + 1;
    }
    Debug.Log(acc); // 15
  }
}

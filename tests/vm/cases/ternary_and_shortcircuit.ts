import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TernaryAndShortcircuit extends UdonSharpBehaviour {
  Start(): void {
    let x: number = 10;
    let r1: string = x > 5 ? "big" : "small";
    Debug.Log(r1);

    let y: number = 3;
    let r2: string = y > 5 ? "big" : "small";
    Debug.Log(r2);

    let a: boolean = false;
    let b: boolean = true;
    Debug.Log(a && b);
    Debug.Log(a || b);
  }
}

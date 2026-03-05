import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class TernaryAndShortcircuit extends UdonSharpBehaviour {
  Start(): void {
    const x: number = 10;
    const r1: string = x > 5 ? "big" : "small";
    Debug.Log(r1);

    const y: number = 3;
    const r2: string = y > 5 ? "big" : "small";
    Debug.Log(r2);

    const a: boolean = false;
    const b: boolean = true;
    Debug.Log(a && b);
    Debug.Log(a || b);
  }
}

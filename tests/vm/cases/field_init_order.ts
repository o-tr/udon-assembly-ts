import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class FieldInitOrder extends UdonSharpBehaviour {
  private count: UdonInt = 10 as UdonInt;
  private name: string = "default";
  private flag: boolean = true;
  private rate: number = 3.25;

  Start(): void {
    // Verify all field defaults are initialized before Start()
    Debug.Log(this.count); // 10
    Debug.Log(this.name); // default
    Debug.Log(this.flag); // True
    Debug.Log(this.rate); // 3.25
  }
}

import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ElementAccessComputed extends UdonSharpBehaviour {
  Start(): void {
    const list: DataList = new DataList();
    list.Add(new DataToken(10));
    list.Add(new DataToken(20));
    list.Add(new DataToken(30));

    // Computed index access
    const base: number = 1;
    const idx: number = base + 1;
    Debug.Log(list[idx as UdonInt].Float); // "30"

    // Loop index access with accumulation
    let sum: number = 0;
    for (let i: number = 0; i < 3; i++) {
      const val: DataToken = list[i as UdonInt];
      sum = sum + val.Float;
    }
    Debug.Log(sum); // "60"
  }
}

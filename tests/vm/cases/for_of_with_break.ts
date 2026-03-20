import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ForOfWithBreak extends UdonSharpBehaviour {
  Start(): void {
    const list: DataList = new DataList();
    list.Add(new DataToken(1));
    list.Add(new DataToken(2));
    list.Add(new DataToken(3));
    list.Add(new DataToken(4));
    list.Add(new DataToken(5));

    // Break when value > 3
    for (const item of list) {
      const val: number = item.Float;
      if (val > 3) {
        break;
      }
      Debug.Log(val);
    }
    // Expected: 1, 2, 3

    // Continue to skip value == 2
    for (const item of list) {
      const val: number = item.Float;
      if (val === 2) {
        continue;
      }
      if (val > 4) {
        break;
      }
      Debug.Log(val);
    }
    // Expected: 1, 3, 4
  }
}

import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataListSetItem extends UdonSharpBehaviour {
  Start(): void {
    const list: DataList = new DataList();
    list.Add(new DataToken(10));
    list.Add(new DataToken(20));
    list.Add(new DataToken(30));

    // Read initial
    Debug.Log(list.get_Item(0 as UdonInt).Float); // 10
    Debug.Log(list.get_Item(1 as UdonInt).Float); // 20

    // Overwrite index 1
    list.set_Item(1 as UdonInt, new DataToken(99));
    Debug.Log(list.get_Item(1 as UdonInt).Float); // 99

    // Verify others unchanged
    Debug.Log(list.get_Item(2 as UdonInt).Float); // 30
  }
}

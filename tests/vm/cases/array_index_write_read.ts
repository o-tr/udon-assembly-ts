import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ArrayIndexWriteRead extends UdonSharpBehaviour {
  Start(): void {
    // Test DataList bracket notation for index read/write
    const list: DataList = new DataList();
    list.Add(new DataToken(10));
    list.Add(new DataToken(20));
    list.Add(new DataToken(30));

    // Read via bracket notation
    Debug.Log(list[0 as UdonInt].Float); // 10
    Debug.Log(list[1 as UdonInt].Float); // 20

    // Write via set_Item then read
    list.set_Item(1 as UdonInt, new DataToken(99));
    Debug.Log(list[1 as UdonInt].Float); // 99

    // Verify other elements unchanged
    Debug.Log(list[0 as UdonInt].Float); // 10
    Debug.Log(list[2 as UdonInt].Float); // 30
  }
}

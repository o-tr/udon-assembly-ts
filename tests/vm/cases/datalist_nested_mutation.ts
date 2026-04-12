import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DatalistNestedMutation extends UdonSharpBehaviour {
  Start(): void {
    const list = new DataList();
    list.Add(new DataToken(2.0));
    list.Add(new DataToken(3.0));
    list.Add(new DataToken(4.0));

    list.set_Item(1 as UdonInt, new DataToken(5.0));
    list.set_Item(2 as UdonInt, new DataToken(9.0));

    Debug.Log(list.get_Item(1 as UdonInt).Float);
    Debug.Log(list.get_Item(2 as UdonInt).Float);
  }
}

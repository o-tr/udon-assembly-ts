import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataListInsertRemoveatFlow extends UdonSharpBehaviour {
  Start(): void {
    const list = new DataList();
    list.Add(new DataToken(1.0));
    list.Add(new DataToken(3.0));
    list.Insert(1n as UdonInt, new DataToken(2.0));
    list.RemoveAt(0n as UdonInt);

    Debug.Log(list.Count);
    Debug.Log(list.get_Item(0n as UdonInt).Double);
    Debug.Log(list.get_Item(1n as UdonInt).Double);
  }
}

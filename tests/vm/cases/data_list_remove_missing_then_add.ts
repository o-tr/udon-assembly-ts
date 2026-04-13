import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataListRemoveMissingThenAdd extends UdonSharpBehaviour {
  Start(): void {
    const list = new DataList();
    list.Add(new DataToken(1.0));
    list.Add(new DataToken(2.0));

    const removedMissing = list.Remove(new DataToken(9.0));
    const removedOne = list.Remove(new DataToken(1.0));
    list.Add(new DataToken(3.0));

    Debug.Log(removedMissing);
    Debug.Log(removedOne);
    Debug.Log(list.Count);
    Debug.Log(list.get_Item(0 as UdonInt).Float);
    Debug.Log(list.get_Item(1 as UdonInt).Float);
  }
}

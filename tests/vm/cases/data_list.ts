import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataListTest extends UdonSharpBehaviour {
  Start(): void {
    const list: DataList = new DataList();
    list.Add(10);
    list.Add(20);
    list.Add(30);
    Debug.Log("added 3 items");
    list.Add(40);
    Debug.Log("added 4th item");
  }
}

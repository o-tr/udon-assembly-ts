import {
  DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ArrayLiteralBasic extends UdonSharpBehaviour {
  Start(): void {
    const arr: DataList = new DataList();
    arr.Add(new DataToken(10.0));
    arr.Add(new DataToken(20.0));
    arr.Add(new DataToken(30.0));
    Debug.Log(arr.Count);
    const first: DataToken = arr.get_Item(0 as UdonInt);
    Debug.Log(first.Float);
    const last: DataToken = arr.get_Item(2 as UdonInt);
    Debug.Log(last.Float);
  }
}

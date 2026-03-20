import {
  DataDictionary,
  type DataList,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ForOfDictKeysLookup extends UdonSharpBehaviour {
  Start(): void {
    const dict: DataDictionary = new DataDictionary();
    dict.SetValue(new DataToken("a"), new DataToken(10));
    dict.SetValue(new DataToken("b"), new DataToken(20));

    // Iterate keys and look up values
    const keys: DataList = dict.GetKeys();
    let count: number = 0;
    for (const key of keys) {
      const val: DataToken = dict.GetValue(key);
      Debug.Log(val.Float);
      count = count + 1;
    }
    Debug.Log(count); // 2
  }
}

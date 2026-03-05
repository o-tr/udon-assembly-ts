import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataDictionaryTest extends UdonSharpBehaviour {
  Start(): void {
    const dict: DataDictionary = new DataDictionary();
    dict.SetValue("name", "Alice");
    dict.SetValue("age", 30);
    Debug.Log("set 2 values");
    Debug.Log(dict.ContainsKey("name"));
    Debug.Log(dict.ContainsKey("missing"));
  }
}

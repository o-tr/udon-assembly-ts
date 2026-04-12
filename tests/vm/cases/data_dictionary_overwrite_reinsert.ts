import {
  DataDictionary,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataDictionaryOverwriteReinsert extends UdonSharpBehaviour {
  Start(): void {
    const dict = new DataDictionary();

    dict.SetValue(new DataToken("x"), new DataToken(10.0));
    dict.SetValue(new DataToken("x"), new DataToken(15.0));
    dict.SetValue(new DataToken("y"), new DataToken(3.0));
    dict.Remove(new DataToken("y"));
    dict.SetValue(new DataToken("y"), new DataToken(8.0));

    Debug.Log(dict.Count);
    Debug.Log(dict.GetValue(new DataToken("x")).Float);
    Debug.Log(dict.GetValue(new DataToken("y")).Float);
  }
}

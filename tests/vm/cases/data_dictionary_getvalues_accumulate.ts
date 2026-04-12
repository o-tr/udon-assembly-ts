import {
  DataDictionary,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataDictionaryGetvaluesAccumulate extends UdonSharpBehaviour {
  Start(): void {
    const dict = new DataDictionary();
    dict.SetValue(new DataToken("a"), new DataToken(1.0));
    dict.SetValue(new DataToken("b"), new DataToken(2.0));
    dict.SetValue(new DataToken("c"), new DataToken(3.0));

    const values = dict.GetValues();
    let sum = 0.0;
    for (const token of values) {
      sum += token.Float;
    }

    Debug.Log(values.Count);
    Debug.Log(sum);
  }
}

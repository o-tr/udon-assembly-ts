import {
  DataDictionary,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DictionaryIterationOrder extends UdonSharpBehaviour {
  Start(): void {
    const dict = new DataDictionary();
    dict.SetValue(new DataToken("b"), new DataToken(20));
    dict.SetValue(new DataToken("a"), new DataToken(10));
    dict.SetValue(new DataToken("c"), new DataToken(30));

    const keys = dict.GetKeys();
    let keyLengthTotal = 0;
    for (const keyToken of keys) {
      keyLengthTotal += keyToken.String.length;
    }

    const values = dict.GetValues();
    let valueSum = 0.0;
    for (const valueToken of values) {
      valueSum += valueToken.Float;
    }

    Debug.Log(keys.Count);
    Debug.Log(keyLengthTotal);
    Debug.Log(valueSum);
  }
}

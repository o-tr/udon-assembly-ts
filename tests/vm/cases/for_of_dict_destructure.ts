import {
  DataDictionary,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class ForOfDictDestructure extends UdonSharpBehaviour {
  Start(): void {
    const dict: DataDictionary = new DataDictionary();
    dict.SetValue(new DataToken("x"), new DataToken(10));
    dict.SetValue(new DataToken("y"), new DataToken(20));

    // Accumulate sum and count to avoid relying on iteration order
    let sum: number = 0;
    let count: number = 0;
    for (const [_key, val] of dict) {
      sum = sum + val.Float;
      count = count + 1;
    }
    Debug.Log(count); // 2
    Debug.Log(sum); // 30
  }
}

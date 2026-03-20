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

    let sum: number = 0;
    for (const [key, val] of dict) {
      Debug.Log(key.String);
      Debug.Log(val.Float);
      sum = sum + val.Float;
    }
    Debug.Log(sum);
  }
}

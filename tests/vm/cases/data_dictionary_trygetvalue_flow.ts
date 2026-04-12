import {
  DataDictionary,
  DataToken,
} from "@ootr/udon-assembly-ts/stubs/DataContainerTypes";
import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class DataDictionaryTrygetvalueFlow extends UdonSharpBehaviour {
  Start(): void {
    const dict = new DataDictionary();
    dict.SetValue(new DataToken("hp"), new DataToken(120.0));
    const hasHp = dict.ContainsKey(new DataToken("hp"));
    const hpValue = hasHp ? dict.GetValue(new DataToken("hp")).Float : 0.0;
    const hasMp = dict.ContainsKey(new DataToken("mp"));

    Debug.Log(hasHp);
    Debug.Log(hpValue);
    Debug.Log(hasMp);
  }
}

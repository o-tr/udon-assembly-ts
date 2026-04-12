import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringConcatDeepMixed extends UdonSharpBehaviour {
  Start(): void {
    const id = 7;
    const ok = true;
    const score = 12;
    const okText = ok ? "yes" : "no";

    const message = "id=" + id + ",ok=" + okText + ",score=" + score;
    const extended = `${message}|tag=${"run"}`;

    Debug.Log(message);
    Debug.Log(extended);
  }
}

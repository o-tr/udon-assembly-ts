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

    // Keep each template under stringBuilderThreshold (6) parts so lowering
    // uses System.String.Concat, not System.Text.StringBuilder (VM lacks that type).
    const head = `id=${id},ok=${okText}`;
    const message = `${head},score=${score}`;
    const extended = `${message}|tag=${"run"}`;

    Debug.Log(message);
    Debug.Log(extended);
  }
}

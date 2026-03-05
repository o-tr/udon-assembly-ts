import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NullCoalescing extends UdonSharpBehaviour {
  Start(): void {
    const a: string = "hello";
    const b: string = a ?? "default";
    Debug.Log(b);
    const c: string = null as unknown as string;
    const d: string = c ?? "fallback";
    Debug.Log(d);
  }
}

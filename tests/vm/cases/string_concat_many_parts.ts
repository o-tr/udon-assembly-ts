import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class StringConcatManyParts extends UdonSharpBehaviour {
  Start(): void {
    // Test multi-part string concat (5 parts, under StringBuilder threshold)
    const a: string = "a";
    const b: string = "b";
    const c: string = "c";
    const d: string = "d";
    const e: string = "e";
    const result: string = a + b + c + d + e;
    Debug.Log(result); // abcde

    // Test concat with intermediate variable
    const first: string = a + b + c;
    const second: string = first + d + e;
    Debug.Log(second); // abcde

    // Chain via assignment
    let chain: string = "x";
    chain = `${chain}y`;
    chain = `${chain}z`;
    chain = `${chain}w`;
    Debug.Log(chain); // xyzw
  }
}

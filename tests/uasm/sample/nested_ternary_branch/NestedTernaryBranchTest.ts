import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class NestedTernaryBranchTest extends UdonSharpBehaviour {
  Start(): void {
    const score = 7;
    const streak = 2;
    const rank =
      score > 10
        ? "high"
        : score > 5
          ? streak > 3
            ? "mid-plus"
            : "mid"
          : "low";

    Debug.Log(rank);
  }
}

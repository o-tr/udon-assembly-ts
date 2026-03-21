import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class Box {
  value: number = 10;
}

@UdonBehaviour()
export class CompoundAssignmentLhsEval extends UdonSharpBehaviour {
  accessCount: number = 0;
  private box: Box = new Box();

  GetBox(): Box {
    this.accessCount = this.accessCount + 1;
    return this.box;
  }

  Start(): void {
    const afterAdd: number = (this.GetBox().value += 5);
    Debug.Log(afterAdd);
    Debug.Log(this.accessCount);
    Debug.Log(this.box.value);

    this.accessCount = 0;
    this.box.value = 1;
    const afterMul: number = (this.GetBox().value *= 3);
    Debug.Log(afterMul);
    Debug.Log(this.accessCount);
    Debug.Log(this.box.value);
  }
}
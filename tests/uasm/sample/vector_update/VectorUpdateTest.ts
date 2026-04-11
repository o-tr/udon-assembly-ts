import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonFloat } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug, Vector3 } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

@UdonBehaviour()
export class VectorUpdateTest extends UdonSharpBehaviour {
  private position: Vector3 = new Vector3(0, 0, 0);

  Start(): void {
    this.position = new Vector3(1.0, 2.0, 3.0);
    this.position = new Vector3(
      (this.position.x + (1.0 as UdonFloat)) as UdonFloat,
      (this.position.y + (2.0 as UdonFloat)) as UdonFloat,
      (this.position.z + (3.0 as UdonFloat)) as UdonFloat,
    );
    Debug.Log(this.position);
  }
}

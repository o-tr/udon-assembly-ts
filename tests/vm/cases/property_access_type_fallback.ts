import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

// Inline class with various property types to verify
// property access type resolution handles non-float types correctly.
// If the fallback incorrectly assigns Single (float) type to
// string/boolean properties, the VM will produce wrong results.
class Info {
  label: string = "hello";
  active: boolean = true;
  count: number = 42;

  getLabel(): string {
    return this.label;
  }
}

@UdonBehaviour()
export class PropertyAccessTypeFallback extends UdonSharpBehaviour {
  private info: Info = new Info();

  Start(): void {
    // Access string property
    Debug.Log(this.info.label);

    // Access boolean property
    Debug.Log(this.info.active);

    // Access number property
    Debug.Log(this.info.count);

    // Access string property via method
    Debug.Log(this.info.getLabel());
  }
}

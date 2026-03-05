import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

enum Direction {
  Up = 0,
  Down = 1,
  Left = 2,
  Right = 3,
}

@UdonBehaviour()
export class EnumUsage extends UdonSharpBehaviour {
  Start(): void {
    const dir: number = Direction.Right;
    Debug.Log(dir);

    if (dir === Direction.Right) {
      Debug.Log("is right");
    }

    switch (dir) {
      case Direction.Up:
        Debug.Log("up");
        break;
      case Direction.Down:
        Debug.Log("down");
        break;
      case Direction.Left:
        Debug.Log("left");
        break;
      case Direction.Right:
        Debug.Log("right");
        break;
    }
  }
}

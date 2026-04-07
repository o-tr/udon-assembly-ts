import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class LRUCache {
  private cache: Map<string, string> = new Map<string, string>();

  constructor(private maxSize: UdonInt) {}

  seed(): void {
    this.cache.set("a", "hello");
  }

  isDifferentSize(): boolean {
    return this.cache.size != this.maxSize;
  }

  isOverflow(): boolean {
    return this.cache.size > this.maxSize;
  }
}

@UdonBehaviour()
export class LruNumericCompareRegression extends UdonSharpBehaviour {
  Start(): void {
    const c = new LRUCache(0 as UdonInt);
    c.seed();
    Debug.Log(c.isDifferentSize());
    Debug.Log(c.isOverflow());
  }
}


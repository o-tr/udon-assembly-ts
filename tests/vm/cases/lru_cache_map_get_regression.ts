import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class LRUCache {
  private cache: Map<string, unknown> = new Map<string, unknown>();

  constructor(private maxSize: UdonInt) {}

  get(key: string): unknown {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: unknown): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, value);

    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  size(): UdonInt {
    return this.cache.size as UdonInt;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }
}

@UdonBehaviour()
export class LruCacheMapGetRegression extends UdonSharpBehaviour {
  Start(): void {
    const cache = new LRUCache(3 as UdonInt);
    cache.set("a", "hello");
    Debug.Log(cache.has("a") ? "True" : "False");
    const got = cache.get("a");
    Debug.Log(got !== undefined ? "True" : "False");

    cache.set("b", "world");
    Debug.Log(cache.size());

    cache.set("c", "foo");
    cache.set("d", "bar");
    Debug.Log(cache.has("a") ? "True" : "False");
    Debug.Log(cache.has("d") ? "True" : "False");
    Debug.Log(cache.size());

    cache.clear();
    Debug.Log(cache.size());
  }
}

import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
import {
  type UdonInt,
  UdonTypeConverters,
} from "@ootr/udon-assembly-ts/stubs/UdonTypes";
import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

class LRUCache {
  private cache: Map<string, unknown>;
  private readonly maxSize: UdonInt;

  constructor(maxSize: UdonInt = UdonTypeConverters.toUdonInt(1000)) {
    if (maxSize <= 0) {
      throw new Error("LRUCache maxSize must be positive");
    }
    this.maxSize = maxSize;
    this.cache = new Map();
  }

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
    return UdonTypeConverters.toUdonInt(this.cache.size);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }
}

@UdonBehaviour()
export class MahjongLruCacheRegression extends UdonSharpBehaviour {
  Start(): void {
    const cache = new LRUCache(UdonTypeConverters.toUdonInt(3));
    cache.set("a", "hello");
    Debug.Log(cache.has("a") ? "True" : "False");
    Debug.Log(cache.get("a") as string);

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

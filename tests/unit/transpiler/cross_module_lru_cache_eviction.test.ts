/**
 * Regression test for cross-module Map<string, unknown>.keys().next().value
 * DataToken unwrap.
 *
 * When an LRUCache class with `Map<string, unknown>` is defined in a separate
 * file and imported by a @UdonBehaviour entry, the batch transpiler previously
 * resolved the Map field type via TypeChecker to bare ExternTypes.dataDictionary
 * (losing key/value type args) and fell back to __get_Reference__SystemObject
 * when unwrapping the iterator value for the eviction path.
 *
 * Fix: tryResolveBuiltinGenericInterface now preserves Map/Set type args by
 * calling checker.getTypeArguments() and building a CollectionTypeSymbol, so
 * the key type (string → String) is available for DataToken getter selection.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchTranspiler } from "../../../src/transpiler/batch/batch_transpiler";

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function buildCrossModuleLruUasm(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cross-module-lru-cache-"),
  );
  createdDirs.push(tempDir);
  const sourceDir = path.join(tempDir, "src");
  const outputDir = path.join(tempDir, "out");
  fs.mkdirSync(sourceDir, { recursive: true });

  fs.writeFileSync(
    path.join(sourceDir, "LRUCache.ts"),
    `
export class LRUCache {
  private cache: Map<string, unknown>;
  private readonly maxSize: bigint;

  constructor(maxSize: bigint) {
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
    if (BigInt(this.cache.size) > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  size(): bigint {
    return BigInt(this.cache.size);
  }
}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(sourceDir, "Main.ts"),
    `
import { LRUCache } from "./LRUCache";

@UdonBehaviour()
class Main extends UdonSharpBehaviour {
  @EntryPoint()
  _start(): void {
    const cache = new LRUCache(3n);
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
  }
}
`,
    "utf8",
  );

  new BatchTranspiler().transpile({
    sourceDir,
    outputDir,
    excludeDirs: [],
    outputExtension: "uasm",
  });

  const files = fs.readdirSync(outputDir).filter((f) => f.endsWith(".uasm"));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(outputDir, files[0]), "utf8");
}

describe("cross-module LRU cache eviction path DataToken unwrap", () => {
  let uasm = "";

  beforeAll(() => {
    uasm = buildCrossModuleLruUasm();
  });

  it("uses __get_String__SystemString (not __get_Reference__SystemObject) for the eviction path", () => {
    // Regression guard: the eviction path must select the typed String getter for string keys.
    // __get_Reference__ appearing anywhere in the output signals the key type was lost.
    expect(uasm).toContain("VRCSDK3DataDataToken.__get_String__SystemString");
    expect(uasm).not.toContain(
      "VRCSDK3DataDataToken.__get_Reference__SystemObject",
    );
  });
});

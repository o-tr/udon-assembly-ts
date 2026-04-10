import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BatchTranspiler,
  resetTranspilerHash,
} from "../../../src/transpiler/batch/batch_transpiler";

const writeFile = (filePath: string, content: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
};

const srcA = `
@UdonBehaviour()
class A extends UdonSharpBehaviour {
  Start(): void {}
}
`;
const srcB = `
@UdonBehaviour()
class B extends UdonSharpBehaviour {
  Start(): void {}
}
`;

describe("incremental compilation", () => {
  it("only recompiles changed entry files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transpiler-inc-"));
    const srcDir = path.join(tempDir, "src");
    const outDir = path.join(tempDir, "out");

    const fileA = path.join(srcDir, "A.ts");
    const fileB = path.join(srcDir, "B.ts");

    writeFile(fileA, srcA);
    writeFile(fileB, srcB);

    const transpiler = new BatchTranspiler();
    const first = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });

    expect(first.outputs.length).toBe(2);

    // Touch fileA with a whitespace-only change
    writeFile(
      fileA,
      `
      @UdonBehaviour()
      class A extends UdonSharpBehaviour {
        Start(): void { }
      }
      `,
    );

    const second = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });

    expect(second.outputs.length).toBe(1);
    expect(second.outputs[0]?.className).toBe("A");
  });

  it("Tier 1: skips recompile when mtime changes but content is identical", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transpiler-t1-"));
    const srcDir = path.join(tempDir, "src");
    const outDir = path.join(tempDir, "out");
    const fileA = path.join(srcDir, "A.ts");
    const fileB = path.join(srcDir, "B.ts");

    writeFile(fileA, srcA);
    writeFile(fileB, srcB);

    const transpiler = new BatchTranspiler();
    const first = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });
    expect(first.outputs.length).toBe(2);

    // Rewrite fileA with identical content (mtime will change, hash stays the same)
    fs.writeFileSync(fileA, srcA, "utf8");
    // Explicitly advance mtime to survive coarse-resolution (1 s) filesystems.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(fileA, future, future);

    const second = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });

    // Content hash matches → no recompilation
    expect(second.outputs.length).toBe(0);
  });

  it("Tier 1: still recompiles when content actually changes", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transpiler-t1b-"));
    const srcDir = path.join(tempDir, "src");
    const outDir = path.join(tempDir, "out");
    const fileA = path.join(srcDir, "A.ts");

    writeFile(fileA, srcA);

    const transpiler = new BatchTranspiler();
    transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });

    // Write genuinely different content
    writeFile(
      fileA,
      `
      @UdonBehaviour()
      class A extends UdonSharpBehaviour {
        Start(): void { const x: number = 1; }
      }
      `,
    );

    const second = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });

    expect(second.outputs.length).toBe(1);
    expect(second.outputs[0]?.className).toBe("A");
  });

  it("Tier 2: output cache serves identical UASM on re-run", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transpiler-t2-"));
    const srcDir = path.join(tempDir, "src");
    const outDir = path.join(tempDir, "out");
    const fileA = path.join(srcDir, "A.ts");

    writeFile(fileA, srcA);

    const transpiler = new BatchTranspiler();
    // First run: full compilation
    transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });
    const uasm1 = fs.readFileSync(path.join(outDir, "A.tasm"), "utf8");

    // Force re-entry into compilation by touching the file with same content
    // (Tier 1 will see same hash → no recompile via file cache; but let's
    // simulate a scenario where we delete the file cache to force the entry
    // point to compile again, testing the output cache directly).
    fs.unlinkSync(path.join(srcDir, ".transpiler-cache.json"));

    // Second run: Tier 1 cache is gone but output cache should still be present
    transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });
    const uasm2 = fs.readFileSync(path.join(outDir, "A.tasm"), "utf8");

    // Output cache served identical UASM
    expect(uasm2).toBe(uasm1);
  });

  it("Tier 2: output cache is invalidated when source changes", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transpiler-t2b-"));
    const srcDir = path.join(tempDir, "src");
    const outDir = path.join(tempDir, "out");
    const fileA = path.join(srcDir, "A.ts");

    writeFile(fileA, srcA);

    const transpiler = new BatchTranspiler();
    transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });
    const uasm1 = fs.readFileSync(path.join(outDir, "A.tasm"), "utf8");

    // Change source so TAC fingerprint changes
    writeFile(
      fileA,
      `
      @UdonBehaviour()
      class A extends UdonSharpBehaviour {
        Start(): void { const x: number = 42; }
      }
      `,
    );

    transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });
    const uasm2 = fs.readFileSync(path.join(outDir, "A.tasm"), "utf8");

    // New UASM must differ from old
    expect(uasm2).not.toBe(uasm1);
  });

  it("Tier 3: skips recompile when unrelated file changes", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transpiler-t3-"));
    const srcDir = path.join(tempDir, "src");
    const outDir = path.join(tempDir, "out");

    // A.ts: entry point (uses no inline classes from B.ts)
    const fileA = path.join(srcDir, "A.ts");
    // B.ts: separate entry point whose code A doesn't depend on
    const fileB = path.join(srcDir, "B.ts");

    writeFile(fileA, srcA);
    writeFile(fileB, srcB);

    const transpiler = new BatchTranspiler();
    transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });

    // Change B's content (completely unrelated to A)
    writeFile(
      fileB,
      `
      @UdonBehaviour()
      class B extends UdonSharpBehaviour {
        Start(): void { const y: number = 99; }
      }
      `,
    );

    const second = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });

    // Only B should be recompiled; A should be skipped
    expect(second.outputs.length).toBe(1);
    expect(second.outputs[0]?.className).toBe("B");
  });

  it("Tier 3: recompiles when base-class file changes", () => {
    // A inherits from BaseA defined in C.ts.
    // collectUsedFiles walks the inheritance chain, so C.ts is in A's
    // usedFiles even though A.ts itself is unchanged.
    // C change → A recompiles. D change → only D recompiles, A skipped.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transpiler-t3c-"));
    const srcDir = path.join(tempDir, "src");
    const outDir = path.join(tempDir, "out");

    const fileA = path.join(srcDir, "A.ts");
    const fileC = path.join(srcDir, "C.ts"); // base class file A depends on
    const fileD = path.join(srcDir, "D.ts"); // unrelated entry point

    // C.ts: non-entry base class (no @UdonBehaviour)
    const srcBase = `
class BaseA extends UdonSharpBehaviour {
  protected baseMethod(): void {}
}
`;
    const srcAExtends = `
@UdonBehaviour()
class A extends BaseA {
  Start(): void { this.baseMethod(); }
}
`;
    const srcD = `
@UdonBehaviour()
class D extends UdonSharpBehaviour {
  Start(): void {}
}
`;

    writeFile(fileA, srcAExtends);
    writeFile(fileC, srcBase);
    writeFile(fileD, srcD);

    const transpiler = new BatchTranspiler();
    const first = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });
    expect(first.outputs.length).toBe(2); // A and D

    // Change C.ts (base class body) — A inherits from it
    writeFile(
      fileC,
      `
class BaseA extends UdonSharpBehaviour {
  protected baseMethod(): void { const _x: number = 1; }
}
`,
    );

    const second = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });
    // A must recompile (BaseA/C.ts is in A's usedFiles via inheritance); D must not
    expect(second.outputs.length).toBe(1);
    expect(second.outputs[0]?.className).toBe("A");

    // Now change D (unrelated to A)
    writeFile(
      fileD,
      `
@UdonBehaviour()
class D extends UdonSharpBehaviour {
  Start(): void { const x: number = 7; }
}
`,
    );

    const third = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });
    // Only D recompiles; A is still cached
    expect(third.outputs.length).toBe(1);
    expect(third.outputs[0]?.className).toBe("D");
  });

  it("v2→v3 cache upgrade: recompiles all and rewrites cache as v3", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transpiler-v2-"));
    const srcDir = path.join(tempDir, "src");
    const outDir = path.join(tempDir, "out");
    const fileA = path.join(srcDir, "A.ts");

    writeFile(fileA, srcA);

    const transpiler = new BatchTranspiler();
    // First run: builds v3 cache
    transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });

    // Overwrite the cache file with a v2-shaped object (no transpilerHash)
    const cachePath = path.join(srcDir, ".transpiler-cache.json");
    const v2Cache = {
      version: 2,
      files: {
        [fileA]: { mtime: fs.statSync(fileA).mtimeMs },
      },
    };
    fs.writeFileSync(cachePath, JSON.stringify(v2Cache), "utf8");

    // Second run: should detect upgrade, recompile everything
    const second = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });
    expect(second.outputs.length).toBe(1);
    expect(second.outputs[0]?.className).toBe("A");

    // Cache should now be v3
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    expect(raw.version).toBe(3);
    expect(raw.transpilerHash).toBeTruthy();
    expect(raw.entryPoints).toBeDefined();
  });

  it("transpiler hash change invalidates all caches", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transpiler-th-"));
    const srcDir = path.join(tempDir, "src");
    const outDir = path.join(tempDir, "out");
    const fileA = path.join(srcDir, "A.ts");

    writeFile(fileA, srcA);

    const transpiler = new BatchTranspiler();
    // First run: populates cache
    const first = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });
    expect(first.outputs.length).toBe(1);

    // Second run: everything cached, no recompilation
    const second = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });
    expect(second.outputs.length).toBe(0);

    // Simulate transpiler code change: write a stale transpilerHash into the
    // cache file, then reset the memoized hash so the next transpile call
    // recomputes it (producing the real hash that won't match "fake-old-hash").
    const cachePath = path.join(srcDir, ".transpiler-cache.json");
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    raw.transpilerHash = "fake-old-hash";
    fs.writeFileSync(cachePath, JSON.stringify(raw), "utf8");
    resetTranspilerHash();

    // Third run: transpilerHash mismatch → full invalidation
    const third = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });
    expect(third.outputs.length).toBe(1);
    expect(third.outputs[0]?.className).toBe("A");
  });
});

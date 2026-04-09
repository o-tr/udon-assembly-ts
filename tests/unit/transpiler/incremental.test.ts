import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BatchTranspiler } from "../../../src/transpiler/batch/batch_transpiler";

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
});

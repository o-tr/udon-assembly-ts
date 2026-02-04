import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BatchTranspiler } from "../../../src/transpiler/batch/batch_transpiler";

const writeFile = (filePath: string, content: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
};

describe("incremental compilation", () => {
  it("only recompiles changed entry files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transpiler-inc-"));
    const srcDir = path.join(tempDir, "src");
    const outDir = path.join(tempDir, "out");

    const fileA = path.join(srcDir, "A.ts");
    const fileB = path.join(srcDir, "B.ts");

    writeFile(
      fileA,
      `
      @UdonBehaviour()
      class A extends UdonSharpBehaviour {
        Start(): void {}
      }
      `,
    );
    writeFile(
      fileB,
      `
      @UdonBehaviour()
      class B extends UdonSharpBehaviour {
        Start(): void {}
      }
      `,
    );

    const transpiler = new BatchTranspiler();
    const first = transpiler.transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      optimize: false,
      excludeDirs: [],
    });

    expect(first.outputs.length).toBe(2);

    // Touch fileA
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
});

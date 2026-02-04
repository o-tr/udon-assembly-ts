/**
 * Unit tests for batch transpiler
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BatchTranspiler } from "../../../src/transpiler/batch/batch_transpiler";
import { UASM_HEAP_LIMIT } from "../../../src/transpiler/heap_limits";

describe("BatchTranspiler", () => {
  it("should generate .uasm for entry point classes", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mahjong-t2-batch-"));
    const sourceDir = path.join(tempDir, "src");
    const outputDir = path.join(tempDir, "out");
    fs.mkdirSync(sourceDir, { recursive: true });

    const sourcePath = path.join(sourceDir, "Demo.ts");
    const source = `
      @UdonBehaviour()
      class Demo extends UdonSharpBehaviour {
        Start(): void {
          let x: number = 1;
          x = x + 1;
        }
      }
    `;

    fs.writeFileSync(sourcePath, source, "utf8");

    const transpiler = new BatchTranspiler();
    const result = transpiler.transpile({
      sourceDir,
      outputDir,
      excludeDirs: [],
    });

    expect(result.outputs).toHaveLength(1);
    const outputPath = result.outputs[0]?.outputPath as string;
    expect(fs.existsSync(outputPath)).toBe(true);

    const output = fs.readFileSync(outputPath, "utf8");
    expect(output).toContain(".data_start");
    expect(output).toContain(".code_start");
  });

  it("should warn when heap usage exceeds limit", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mahjong-t2-batch-"));
    const sourceDir = path.join(tempDir, "src");
    const outputDir = path.join(tempDir, "out");
    fs.mkdirSync(sourceDir, { recursive: true });

    const overflowCount = UASM_HEAP_LIMIT + 8;
    const filler = Array.from(
      { length: overflowCount },
      (_, i) => `let value${i}: number = ${i};`,
    ).join("\n");
    const sourcePath = path.join(sourceDir, "HeapTest.ts");
    const source = `
      @UdonBehaviour()
      class HeapTest extends UdonSharpBehaviour {
        Start(): void {
          ${filler}
        }
      }
    `;

    fs.writeFileSync(sourcePath, source, "utf8");

    const transpiler = new BatchTranspiler();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = transpiler.transpile({
      sourceDir,
      outputDir,
      excludeDirs: [],
    });

    expect(result.outputs).toHaveLength(1);
    const outputPath = result.outputs[0]?.outputPath as string;
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

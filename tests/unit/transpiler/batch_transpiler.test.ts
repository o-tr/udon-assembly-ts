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

  it("should collect top-level consts from inline class files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-const-"));
    const sourceDir = path.join(tempDir, "src");
    const outputDir = path.join(tempDir, "out");
    fs.mkdirSync(sourceDir, { recursive: true });

    fs.writeFileSync(
      path.join(sourceDir, "Helper.ts"),
      `
const HELPER_VALUE: number = 42;

class Helper {
  static getValue(): number {
    return HELPER_VALUE;
  }
}
`,
      "utf8",
    );

    fs.writeFileSync(
      path.join(sourceDir, "Entry.ts"),
      `
import { Helper } from "./Helper";

@UdonBehaviour()
class Entry extends UdonSharpBehaviour {
  Start(): void {
    let v: number = Helper.getValue();
  }
}
`,
      "utf8",
    );

    const transpiler = new BatchTranspiler();
    const result = transpiler.transpile({
      sourceDir,
      outputDir,
      excludeDirs: [],
    });

    expect(result.outputs).toHaveLength(1);
    const output = fs.readFileSync(
      result.outputs[0]?.outputPath as string,
      "utf8",
    );
    // Const value 42 is inlined; codegen renames to internal names
    expect(output).toContain("42");
    expect(output).toContain("__getValue_Helper");
  });

  it("should merge top-level consts from multiple inline class files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-const-"));
    const sourceDir = path.join(tempDir, "src");
    const outputDir = path.join(tempDir, "out");
    fs.mkdirSync(sourceDir, { recursive: true });

    fs.writeFileSync(
      path.join(sourceDir, "Alpha.ts"),
      `
const ALPHA_VAL: number = 1;

class Alpha {
  static getAlpha(): number {
    return ALPHA_VAL;
  }
}
`,
      "utf8",
    );

    fs.writeFileSync(
      path.join(sourceDir, "Beta.ts"),
      `
const BETA_VAL: number = 2;

class Beta {
  static getBeta(): number {
    return BETA_VAL;
  }
}
`,
      "utf8",
    );

    fs.writeFileSync(
      path.join(sourceDir, "Entry.ts"),
      `
import { Alpha } from "./Alpha";
import { Beta } from "./Beta";

const ENTRY_VAL: number = 0;

@UdonBehaviour()
class Entry extends UdonSharpBehaviour {
  Start(): void {
    let a: number = Alpha.getAlpha();
    let b: number = Beta.getBeta();
    let e: number = ENTRY_VAL;
  }
}
`,
      "utf8",
    );

    const transpiler = new BatchTranspiler();
    const result = transpiler.transpile({
      sourceDir,
      outputDir,
      excludeDirs: [],
    });

    expect(result.outputs).toHaveLength(1);
    const output = fs.readFileSync(
      result.outputs[0]?.outputPath as string,
      "utf8",
    );
    // All three const values are inlined from different files
    expect(output).toContain("__getAlpha_Alpha");
    expect(output).toContain("__getBeta_Beta");
  });

  it("should throw AggregateTranspileError for duplicate top-level consts across files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-dup-"));
    const sourceDir = path.join(tempDir, "src");
    const outputDir = path.join(tempDir, "out");
    fs.mkdirSync(sourceDir, { recursive: true });

    fs.writeFileSync(
      path.join(sourceDir, "Helper.ts"),
      `
const SHARED: number = 99;

class Helper {
  static getValue(): number {
    return SHARED;
  }
}
`,
      "utf8",
    );

    fs.writeFileSync(
      path.join(sourceDir, "Entry.ts"),
      `
import { Helper } from "./Helper";

const SHARED: number = 1;

@UdonBehaviour()
class Entry extends UdonSharpBehaviour {
  Start(): void {
    let v: number = Helper.getValue();
    let s: number = SHARED;
  }
}
`,
      "utf8",
    );

    // Duplicate top-level const "SHARED" exists in both Entry.ts and Helper.ts.
    // The parser's shared symbol table detects the collision at parse time,
    // preventing Helper.ts from being registered. This causes a transpile error.
    const transpiler = new BatchTranspiler();
    expect(() =>
      transpiler.transpile({
        sourceDir,
        outputDir,
        excludeDirs: [],
      }),
    ).toThrow();
  });
});

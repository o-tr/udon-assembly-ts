/**
 * UASM Snapshot Tests
 *
 * Automatically discovers test cases in tests/uasm/sample/ and validates
 * that TypeScript files transpile to expected UASM output.
 */

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BatchTranspiler } from "../../src/transpiler/batch/batch_transpiler";

const SAMPLES_DIR = path.resolve(__dirname, "sample");

interface TestCase {
  name: string;
  sampleDir: string;
  tsFiles: string[];
  uasmFiles: string[];
}

function discoverTestCases(): TestCase[] {
  if (!existsSync(SAMPLES_DIR)) {
    return [];
  }

  const entries = readdirSync(SAMPLES_DIR, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const sampleDir = path.join(SAMPLES_DIR, entry.name);
      const files = readdirSync(sampleDir);

      return {
        name: entry.name,
        sampleDir,
        tsFiles: files
          .filter((f) => f.endsWith(".ts"))
          .map((f) => path.join(sampleDir, f)),
        uasmFiles: files
          .filter((f) => f.endsWith(".uasm"))
          .map((f) => path.join(sampleDir, f)),
      };
    })
    .filter((tc) => tc.tsFiles.length > 0 && tc.uasmFiles.length > 0);
}

function normalizeUasm(uasm: string): string[] {
  return uasm
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith(".behaviourSyncMode"))
    .filter((line) => !line.startsWith("__extern_"))
    .map((line) => {
      // Mask variable names and hex values for stable matching
      let normalized = line;

      // Mask constant variables
      normalized = normalized.replace(/__const_[a-zA-Z0-9_]+/g, "%CONST_VAR");

      // Mask reflection metadata variables (added by transpiler optionally)
      normalized = normalized.replace(/__refl_[a-zA-Z0-9_]+/g, "%REFL_VAR");

      // Normalize EXTERN operands (interned symbol vs string literal)
      normalized = normalized.replace(/^EXTERN,\s+.+$/, "EXTERN");

      // Mask hex constants (type ids etc.)
      normalized = normalized.replace(/0x[0-9a-fA-F]+/g, "%HEX");

      // Mask other internal variables/labels if needed
      // normalized = normalized.replace(/__[a-zA-Z0-9_]+/g, "%INTERNAL_VAR");

      return normalized;
    });
}

describe("UASM Snapshot Tests", () => {
  const testCases = discoverTestCases();

  if (testCases.length === 0) {
    it.skip("no test cases found", () => {});
    return;
  }

  for (const testCase of testCases) {
    it(`transpiles "${testCase.name}" correctly`, () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "uasm-test-"));
      const sourceDir = path.join(tempDir, "src");
      const outputDir = path.join(tempDir, "out");

      try {
        cpSync(testCase.sampleDir, sourceDir, {
          recursive: true,
          filter: (src) => !src.endsWith(".uasm") && !src.endsWith(".cs"),
        });

        const transpiler = new BatchTranspiler();
        const result = transpiler.transpile({
          sourceDir,
          outputDir,
          excludeDirs: [],
        });

        for (const uasmFile of testCase.uasmFiles) {
          const baseName = path.basename(uasmFile, ".uasm");
          const expectedUasm = readFileSync(uasmFile, "utf-8");

          if (expectedUasm.trim() === "") {
            continue;
          }

          const actualPath = path.join(outputDir, `${baseName}.uasm`);

          expect(
            existsSync(actualPath),
            `Expected output file: ${baseName}.uasm (generated: ${result.outputs.map((o) => o.className).join(", ")})`,
          ).toBe(true);

          const actualUasm = readFileSync(actualPath, "utf-8");

          const normalizedActual = normalizeUasm(actualUasm);
          const normalizedExpected = normalizeUasm(expectedUasm);

          try {
            expect(normalizedActual).toEqual(normalizedExpected);
          } catch (e) {
            console.log(
              "Expected:",
              JSON.stringify(normalizedExpected, null, 2),
            );
            console.log("Actual:", JSON.stringify(normalizedActual, null, 2));
            throw e;
          }
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }
});

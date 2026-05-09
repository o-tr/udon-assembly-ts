/**
 * Batch-transpiler version of the tenpai param-direct-return regression.
 *
 * Splits the scenario across four files to drive it through BatchTranspiler,
 * exercising cross-module type resolution for WaitInfo (a type-alias over an
 * anonymous struct). If structuralInterfaceForType returns null for cross-module
 * types, the entire untracked-handle pipeline collapses silently and no
 * UntrackedStructuralUnionReturn diagnostic or D-3 dispatch is emitted.
 *
 * Decisive outcomes:
 *   FAIL → batch type resolution breaks structuralInterfaceForType; that's the bug.
 *   PASS → bug is mahjong-specific; need HandAnalyzer.ts excerpts or failing UASM.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import {
  BatchTranspiler,
  type TranspileWarning,
} from "../../../src/transpiler/index.js";

let assembledUasm = "";
let batchDiagnostics: TranspileWarning[] = [];
let batchOutputCount = 0;

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("tenpai param-direct-return regression (BatchTranspiler)", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);

    const srcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tenpai-batch-regression-"),
    );
    const outDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tenpai-batch-regression-out-"),
    );
    createdDirs.push(srcDir, outDir);

    // Minimal decorator stubs so the transpiler identifies the entry class.
    fs.writeFileSync(
      path.join(srcDir, "stubs.ts"),
      `
export function UdonBehaviour(): ClassDecorator { return () => {}; }
export class UdonSharpBehaviour {}
`,
      "utf8",
    );

    // types.ts: anonymous-struct type alias (mirrors WaitInfo in HandAnalyzer.ts)
    fs.writeFileSync(
      path.join(srcDir, "types.ts"),
      `
export type WaitInfo = { found: boolean; count: number };
`,
      "utf8",
    );

    // inner.ts: NC with method-call LHS → returnTrackingInvalidated for getInfo
    fs.writeFileSync(
      path.join(srcDir, "inner.ts"),
      `
import type { WaitInfo } from "./types";

export class Inner {
  static tryGet(x: number): WaitInfo | null {
    return x > 0 ? { found: true, count: x } : null;
  }
  // NC with method-call LHS → split skipped → Temporary result
  // → returnTrackingInvalidated=true → caller's __inline_ret is untracked
  static getInfo(x: number): WaitInfo {
    return Inner.tryGet(x) ?? { found: false, count: 0 };
  }
}
`,
      "utf8",
    );

    // hand_analyzer.ts: parameter-direct-return pattern (HandAnalyzer.ts:229,872)
    fs.writeFileSync(
      path.join(srcDir, "hand_analyzer.ts"),
      `
import type { WaitInfo } from "./types";

export class HandAnalyzer {
  static passThrough(p: WaitInfo | null): WaitInfo {
    if (p === null) return { found: false, count: -1 }; // tracked literal sibling
    return p; // UntrackedStructuralUnionReturn when p is untracked
  }
}
`,
      "utf8",
    );

    // main.ts: entry class — Case 3: untracked NC result → passThrough → .count
    fs.writeFileSync(
      path.join(srcDir, "main.ts"),
      `
import { UdonBehaviour, UdonSharpBehaviour } from "./stubs";
import { Inner } from "./inner";
import { HandAnalyzer } from "./hand_analyzer";

// Debug is a Unity extern resolved via the global extern registry.
// Defining it in stubs.ts would make the transpiler treat it as an inline
// class and inline its empty body instead of emitting an EXTERN call,
// so it is intentionally left unimported here.
declare const Debug: { Log(v: unknown): void };

@UdonBehaviour()
export class TestBehaviour extends UdonSharpBehaviour {
  Start(): void {
    // fromNC is untracked (returnTrackingInvalidated from NC with method-call LHS)
    const fromNC = Inner.getInfo(5);
    // passThrough must propagate untracked from arg → param p
    // → "return p" → UntrackedStructuralUnionReturn → returnTrackingInvalidated
    // → caller emits D-3 dispatch (__uninst_prop_*) instead of direct prefix read
    const r3 = HandAnalyzer.passThrough(fromNC);
    // Feed into Debug.Log (a live Unity extern call) so the property access
    // is never dead-code-eliminated, mirroring the inline test.
    Debug.Log(r3.count);
  }
}
`,
      "utf8",
    );

    const result = new BatchTranspiler().transpile({
      sourceDir: srcDir,
      outputDir: outDir,
      silent: true,
      useOutputCache: false,
    });

    batchOutputCount = result.outputs.length;
    batchDiagnostics = result.diagnostics ?? [];

    // Read all generated assembly files (extension may be .tasm or .uasm)
    const asmFiles = fs
      .readdirSync(outDir)
      .filter((f) => f.endsWith(".tasm") || f.endsWith(".uasm"));
    assembledUasm = asmFiles
      .map((f) => fs.readFileSync(path.join(outDir, f), "utf8"))
      .join("\n");
  });

  it("BatchTranspiler produces at least one output file (sanity)", () => {
    expect(
      batchOutputCount,
      "BatchTranspiler produced no output — subsequent assertions are vacuous",
    ).toBeGreaterThan(0);
  });

  it("UntrackedStructuralUnionReturn diagnostic fires for cross-module param-direct-return", () => {
    // If structuralInterfaceForType returns null for the cross-module WaitInfo type,
    // the "stay neutral" path in visitReturnStatement is never entered and this
    // diagnostic is never emitted — revealing that the batch type resolution is broken.
    const diag = batchDiagnostics.find(
      (d) => d.code === "UntrackedStructuralUnionReturn",
    );
    expect(diag).toBeDefined();
  });

  it("D-3 dispatch (__uninst_prop_*) appears in generated assembly for cross-module untracked arg", () => {
    // Guard: verify Debug.Log was emitted as a live EXTERN (UnityEngineDebug),
    // not silently dropped. This confirms r3.count is live so the assertion
    // below is not vacuous.
    expect(assembledUasm).toContain("UnityEngineDebug");

    // D-3 dispatch creates a TAC-level slot named __uninst_prop_N which the
    // assembler preserves verbatim in the .tasm data section (local variables
    // keep their TAC names in the output format). BatchResult does not expose
    // a tac field, so this is the only layer at which the slot name is
    // observable without refactoring the batch pipeline. If the assembly
    // lowering stage ever renames these slots, update this pattern to match.
    //
    // If returnTrackingInvalidated was not set — because structuralInterfaceForType
    // returned null for the cross-module WaitInfo, or untrackedStructuralHandleVars
    // propagation failed — the caller uses a direct prefix read and __uninst_prop_N
    // never appears in the output.
    expect(assembledUasm).toMatch(/__uninst_prop_\d+/);
  });
});

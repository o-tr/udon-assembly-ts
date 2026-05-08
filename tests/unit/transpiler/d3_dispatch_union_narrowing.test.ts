/**
 * Regression tests for D3 dispatch union-member narrowing.
 *
 * When an erased receiver has a declared union type (e.g. A | B), the TypeChecker
 * can expose individual union members.  Intersecting those members with the
 * property-based candidateClasses set should exclude unrelated classes that
 * merely share the property name, suppressing D3DispatchFallback warnings.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import {
  BatchTranspiler,
  TypeScriptToUdonTranspiler,
} from "../../../src/transpiler/index.js";

// Minimal stubs so TypeScript can fully type-check the test sources.  The
// transpiler detects @UdonBehaviour by decorator name, not by structural type,
// so the stub bodies only need to satisfy TS, not Udon semantics.
const STUBS_SRC = `
export function UdonBehaviour(): ClassDecorator { return () => {}; }
export class UdonSharpBehaviour {}
`;

/** Create a fresh pair of temp dirs with stubs.ts already written. */
function makeTempDirs(): {
  srcDir: string;
  outDir: string;
  cleanup: () => void;
} {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-union-src-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-union-out-"));
  fs.writeFileSync(path.join(srcDir, "stubs.ts"), STUBS_SRC);
  return {
    srcDir,
    outDir,
    cleanup: () => {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    },
  };
}

describe("D3 dispatch union-member narrowing", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("does not emit D3DispatchFallback when TypeChecker union members narrow candidateClasses", () => {
    // A and B are the union members; Noise also has `.val` but is NOT part of
    // the union type.  The receiver is a method parameter typed `A | B` — the
    // transpiler collapses the union to ObjectType (TAC level), so D3
    // property-based fallback fires.  Without narrowing, candidateClasses =
    // {A, B, Noise} and D3DispatchFallback fires; with narrowing the
    // TypeChecker still sees `A | B` at the AST node, so only {A, B} are
    // dispatched and the warning is suppressed.
    //
    // Uses BatchTranspiler with real temp files so that TypeScript's
    // getTypeAtLocation can resolve union members (the inline transpiler
    // cannot resolve imports at test time, causing TypeChecker crashes).
    const src = `
import { UdonBehaviour, UdonSharpBehaviour } from "./stubs";

class A {
  constructor(public readonly val: number) {}
}
class B {
  constructor(public readonly val: number) {}
}
class Noise {
  constructor(public readonly val: number) {}
}

@UdonBehaviour()
class Main extends UdonSharpBehaviour {
  readVal(shape: A | B): number {
    return shape.val;
  }
  Start(): void {
    const a = new A(1);
    const b = new B(2);
    // Instantiate Noise so it appears in allInlineInstances — without union
    // narrowing this inflates candidateClasses to {A, B, Noise} and triggers
    // the D3DispatchFallback warning.
    const _n = new Noise(3);
    this.readVal(a);
  }
}
`;
    const { srcDir, outDir, cleanup } = makeTempDirs();
    try {
      fs.writeFileSync(path.join(srcDir, "main.ts"), src);
      const result = new BatchTranspiler().transpile({
        sourceDir: srcDir,
        outputDir: outDir,
        silent: true,
        useOutputCache: false,
      });
      const d3 =
        result.diagnostics?.filter(
          (d) =>
            d.code === "D3DispatchFallback" &&
            d.location.filePath.includes("main.ts"),
        ) ?? [];
      expect(d3).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("does not emit D3DispatchFallback when ALL candidateClasses are union members (exact-match case)", () => {
    // This is the discriminating test for the `narrowedCandidates.length > 0`
    // condition change: when candidateClasses == union members exactly (no
    // extra "Noise" class), the old condition `> 0 && < candidateClasses.size`
    // would have left the warning fired; the new `> 0` condition suppresses it.
    const src = `
import { UdonBehaviour, UdonSharpBehaviour } from "./stubs";

class X {
  constructor(public readonly code: number) {}
}
class Y {
  constructor(public readonly code: number) {}
}

@UdonBehaviour()
class Main extends UdonSharpBehaviour {
  readCode(shape: X | Y): number {
    return shape.code;
  }
  Start(): void {
    const x = new X(1);
    const y = new Y(2);
    // Both X and Y in allInlineInstances; both have .code; union type is X | Y.
    // candidateClasses = {X, Y} == union members — exact match, not a proper
    // subset.  With the old condition this still fires D3DispatchFallback.
    this.readCode(x);
  }
}
`;
    const { srcDir, outDir, cleanup } = makeTempDirs();
    try {
      fs.writeFileSync(path.join(srcDir, "main.ts"), src);
      const result = new BatchTranspiler().transpile({
        sourceDir: srcDir,
        outputDir: outDir,
        silent: true,
        useOutputCache: false,
      });
      const d3 =
        result.diagnostics?.filter(
          (d) =>
            d.code === "D3DispatchFallback" &&
            d.location.filePath.includes("main.ts"),
        ) ?? [];
      expect(d3).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("does not emit D3DispatchFallback for NamedClass | anonymous-struct union (naming consistency)", () => {
    // Reproduces the TerminalBasedYaku pattern: receiver is typed as a union of a
    // named class and an anonymous struct literal type (e.g. Hand | {isOpen, tiles}).
    // The anonymous struct enters allInlineInstances when a separate helper method
    // takes the struct type as a plain (non-union) parameter and is called with an
    // object literal.  Both the className stored in allInlineInstances and the name
    // returned by resolveUnionMemberNamesFromAstNode go through resolveFromTsType,
    // so their "__anon_..." string is constructed identically.
    //
    // Without this naming consistency the memberSet.has(c) filter would silently
    // exclude the anon-struct candidate and the warning would fire.
    const src = `
import { UdonBehaviour, UdonSharpBehaviour } from "./stubs";

class Tile {
  constructor(public readonly code: number) {}
}

class Hand {
  constructor(
    public readonly isOpen: boolean,
    public readonly tiles: Tile[],
    public readonly type: string,
  ) {}
}

// Helper takes the anonymous struct type directly (not in a union) so that
// passing an object literal to it registers the struct in allInlineInstances.
class HandBuilder {
  makeRaw(data: { isOpen: boolean; tiles: Tile[]; type: string }): void {}
}

@UdonBehaviour()
class Main extends UdonSharpBehaviour {
  // receiver collapses to ObjectType (erased union); D3 dispatch fires for "tiles"
  getTiles(hand: Hand | { isOpen: boolean; tiles: Tile[]; type: string }): Tile[] {
    return hand.tiles;
  }
  Start(): void {
    const t = new Tile(1);
    const h = new Hand(false, [t], "normal");
    // Object literal passes through evaluateArgsWithExpectedTypes, setting
    // currentExpectedType to the InterfaceTypeSymbol, which registers the anon
    // struct in allInlineInstances under "__anon_isOpen:boolean|tiles:Tile[]|type:string"
    // (or equivalent resolved name).
    const builder = new HandBuilder();
    builder.makeRaw({ isOpen: false, tiles: [t], type: "raw" });
    this.getTiles(h);
  }
}
`;
    const { srcDir, outDir, cleanup } = makeTempDirs();
    try {
      fs.writeFileSync(path.join(srcDir, "main.ts"), src);
      const result = new BatchTranspiler().transpile({
        sourceDir: srcDir,
        outputDir: outDir,
        silent: true,
        useOutputCache: false,
      });
      const d3 =
        result.diagnostics?.filter(
          (d) =>
            d.code === "D3DispatchFallback" &&
            d.location.filePath.includes("main.ts"),
        ) ?? [];
      expect(d3).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("does not emit D3DispatchFallback for nullable union (A | B | null) — nullish member stripped", () => {
    // Verifies the isNullishType filter in resolveUnionMemberNamesFromAstNode.
    // The property access must occur at a site where TypeScript has NOT flow-narrowed
    // away null, so getTypeAtLocation returns the full P | Q | null union.
    // ScoreReader.read accesses item.score without a null guard; TypeScript strict
    // mode flags this but BatchTranspiler does not check diagnostics — it only uses
    // the TypeChecker for type resolution.  At the item.score site the TypeChecker
    // returns P | Q | null.  resolveUnionMemberNamesFromAstNode strips null via
    // isNullishType → [P, Q] → narrowedCandidates = [P, Q] → warning suppressed.
    // If isNullishType were broken (e.g., null not stripped), null would slip into
    // the loop, resolveFromTsType(null) returns ObjectType, the ObjectType guard
    // returns null, and D3DispatchFallback would fire — making the test fail.
    const src = `
import { UdonBehaviour, UdonSharpBehaviour } from "./stubs";

class P {
  constructor(public readonly score: number) {}
}
class Q {
  constructor(public readonly score: number) {}
}

// Intentionally no null guard: TypeChecker sees item as P | Q | null at item.score,
// exercising the isNullishType strip.  TypeScript strict-mode errors on this
// ("Object is possibly 'null'") but the BatchTranspiler ignores diagnostics.
class ScoreReader {
  read(item: P | Q | null): number {
    return item.score;
  }
}

@UdonBehaviour()
class Main extends UdonSharpBehaviour {
  Start(): void {
    const p = new P(1);
    const q = new Q(2);
    const reader = new ScoreReader();
    reader.read(p);
  }
}
`;
    const { srcDir, outDir, cleanup } = makeTempDirs();
    try {
      fs.writeFileSync(path.join(srcDir, "main.ts"), src);
      const result = new BatchTranspiler().transpile({
        sourceDir: srcDir,
        outputDir: outDir,
        silent: true,
        useOutputCache: false,
      });
      const d3 =
        result.diagnostics?.filter(
          (d) =>
            d.code === "D3DispatchFallback" &&
            d.location.filePath.includes("main.ts"),
        ) ?? [];
      expect(d3).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("still emits D3DispatchFallback when receiver type is not a union (cannot narrow)", () => {
    // When the receiver is typed as `any` (erased to ObjectType), there is no
    // union type for TypeChecker to expose, so narrowing cannot help and the
    // warning must still fire.  Both A and B have `.val`, so candidateClasses
    // has 2 entries, and there is no proper-subset to dispatch to.
    const source = `
class Main {
  getAny(): any { return null; }
  Start(): void {
    new A(1);
    new B(2);
    const x: any = this.getAny();
    (x as any).val;
  }
}
class A {
  constructor(public readonly val: number) {}
}
class B {
  constructor(public readonly val: number) {}
}
`;
    const result = new TypeScriptToUdonTranspiler().transpile(source);
    const d3 =
      result.diagnostics?.filter((d) => d.code === "D3DispatchFallback") ?? [];
    expect(d3.length).toBeGreaterThan(0);
  });
});

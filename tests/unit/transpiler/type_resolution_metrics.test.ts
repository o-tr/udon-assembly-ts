import * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetStep10MetricsCacheForTest,
  step10Metrics,
} from "../../../src/transpiler/frontend/type_resolution_metrics.js";

const FIXTURE_FILE = "/fixture.ts";
const FIXTURE_SOURCE = `
export class WinResult { score = 0; }
export type MaybeWin = WinResult | null;
declare const a: MaybeWin;
declare function f(x: WinResult): WinResult;
export const _a = a;
export const _f = f;
`;

function createInMemoryChecker(): {
  checker: ts.TypeChecker;
  program: ts.Program;
  sourceFile: ts.SourceFile;
} {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(compilerOptions, true);
  const original = {
    getSourceFile: host.getSourceFile.bind(host),
    fileExists: host.fileExists.bind(host),
    readFile: host.readFile.bind(host),
  };
  const fixtureSF = ts.createSourceFile(
    FIXTURE_FILE,
    FIXTURE_SOURCE,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS,
  );
  host.getSourceFile = (fileName, lang, onError, shouldCreateNew) => {
    if (fileName === FIXTURE_FILE) return fixtureSF;
    return original.getSourceFile(fileName, lang, onError, shouldCreateNew);
  };
  host.fileExists = (f) => f === FIXTURE_FILE || original.fileExists(f);
  host.readFile = (f) =>
    f === FIXTURE_FILE ? FIXTURE_SOURCE : original.readFile(f);

  const program = ts.createProgram({
    rootNames: [FIXTURE_FILE],
    options: compilerOptions,
    host,
  });
  return {
    checker: program.getTypeChecker(),
    program,
    sourceFile: fixtureSF,
  };
}

function findVarType(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  name: string,
): ts.Type {
  let result: ts.Type | undefined;
  const visit = (node: ts.Node): void => {
    if (result) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      result = checker.getTypeAtLocation(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!result) throw new Error(`var ${name} not found in fixture`);
  return result;
}

function findFunctionParamType(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  fnName: string,
): ts.Type {
  let result: ts.Type | undefined;
  const visit = (node: ts.Node): void => {
    if (result) return;
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === fnName &&
      node.parameters.length > 0
    ) {
      result = checker.getTypeAtLocation(node.parameters[0]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!result) throw new Error(`function ${fnName} not found in fixture`);
  return result;
}

describe("step10Metrics sample capture", () => {
  beforeEach(() => {
    process.env.UDON_TS_STEP10_METRICS = "1";
    __resetStep10MetricsCacheForTest();
    step10Metrics.__clearForTest();
  });

  afterEach(() => {
    delete process.env.UDON_TS_STEP10_METRICS;
    __resetStep10MetricsCacheForTest();
    step10Metrics.__clearForTest();
  });

  it("records sample metadata for a heterogeneous union (WinResult | null)", () => {
    const { checker, sourceFile } = createInMemoryChecker();
    const aType = findVarType(sourceFile, checker, "a");

    step10Metrics.record("WinResult | null", aType, checker);

    const json = step10Metrics.flush();
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json as string);
    const entry = parsed.topTypes.find(
      (t: { typeText: string }) => t.typeText === "WinResult | null",
    );
    expect(entry).toBeDefined();
    expect(entry.sample).toBeDefined();
    // Either the type carries Union flag (D-#2 territory) or an alias name
    // that resolves to a union target (D-#1 territory). Both are valid;
    // the test only validates that the plumbing captures *some* signal.
    const sample = entry.sample;
    const looksLikeUnion =
      sample.typeFlags.includes("Union") ||
      (sample.aliasTargetFlags ?? "").includes("Union");
    expect(looksLikeUnion).toBe(true);
    if (sample.unionMemberFlags) {
      // At least one constituent should be Null (the `| null`).
      expect(
        sample.unionMemberFlags.some((f: string) => f.includes("Null")),
      ).toBe(true);
    }
    expect(typeof sample.hasSymbol).toBe("boolean");
    expect(sample.sampleCount).toBe(1);
  });

  it("records sample metadata for a project class (WinResult)", () => {
    const { checker, sourceFile } = createInMemoryChecker();
    const winResultType = findFunctionParamType(sourceFile, checker, "f");

    step10Metrics.record("WinResult", winResultType, checker);

    const json = step10Metrics.flush();
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json as string);
    const entry = parsed.topTypes.find(
      (t: { typeText: string }) => t.typeText === "WinResult",
    );
    expect(entry).toBeDefined();
    expect(entry.sample).toBeDefined();
    expect(entry.sample.hasSymbol).toBe(true);
    // typeFlags should include Object (it's a class instance type).
    expect(entry.sample.typeFlags).toContain("Object");
    // No alias on a direct class-name type.
    expect(entry.sample.aliasName).toBeNull();
  });

  it("does not record samples when metrics are disabled", () => {
    delete process.env.UDON_TS_STEP10_METRICS;
    __resetStep10MetricsCacheForTest();
    step10Metrics.__clearForTest();

    const { checker, sourceFile } = createInMemoryChecker();
    const aType = findVarType(sourceFile, checker, "a");

    step10Metrics.record("WinResult | null", aType, checker);

    expect(step10Metrics.flush()).toBeNull();
  });

  it("merges duplicate typeText counts but keeps the first sample", () => {
    const { checker, sourceFile } = createInMemoryChecker();
    const aType = findVarType(sourceFile, checker, "a");
    const winResultType = findFunctionParamType(sourceFile, checker, "f");

    // First record uses aType (a Union); second record under the SAME key
    // uses winResultType (a class). The sample should still reflect the
    // first occurrence.
    step10Metrics.record("WinResult | null", aType, checker);
    step10Metrics.record("WinResult | null", winResultType, checker);

    const parsed = JSON.parse(step10Metrics.flush() as string);
    const entry = parsed.topTypes.find(
      (t: { typeText: string }) => t.typeText === "WinResult | null",
    );
    expect(entry.count).toBe(2);
    // First-occurrence sample preserved: `aType` is the union, so its
    // typeFlags or aliasTargetFlags should reflect Union — winResultType
    // (a non-union class) would not match this assertion.
    const looksLikeUnion =
      entry.sample.typeFlags.includes("Union") ||
      (entry.sample.aliasTargetFlags ?? "").includes("Union");
    expect(looksLikeUnion).toBe(true);
  });
});

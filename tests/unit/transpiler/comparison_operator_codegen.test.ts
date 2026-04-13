import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

const SOURCE = `
  import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
  import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
  import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
  import { Debug, Mathf, Time } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

  @UdonBehaviour()
  export class ComparisonOrderTest extends UdonSharpBehaviour {
    public lhsValue: UdonInt = 0 as UdonInt;
    public rhsValue: UdonInt = 0 as UdonInt;

    Start(): void {
      this.lhsValue = Mathf.FloorToInt(Time.time);
      this.rhsValue = Mathf.FloorToInt(Time.deltaTime);
      const lhs: UdonInt = this.lhsValue;
      const rhs: UdonInt = this.rhsValue;
      const lt = lhs < rhs;
      const gt = lhs > rhs;
      const le = lhs <= rhs;
      const ge = lhs >= rhs;
      Debug.Log(lt);
      Debug.Log(gt);
      Debug.Log(le);
      Debug.Log(ge);
    }
  }
`;

const OP_SIGNATURES = {
  lt: "SystemInt32.__op_LessThan__SystemInt32_SystemInt32__SystemBoolean",
  gt: "SystemInt32.__op_GreaterThan__SystemInt32_SystemInt32__SystemBoolean",
  le: "SystemInt32.__op_LessThanOrEqual__SystemInt32_SystemInt32__SystemBoolean",
  ge: "SystemInt32.__op_GreaterThanOrEqual__SystemInt32_SystemInt32__SystemBoolean",
} as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findExternSymbolBySignature(uasm: string, signature: string): string {
  const match = uasm.match(
    new RegExp(
      `^\\s*(__extern_\\d+):\\s+%SystemString,\\s+"${escapeRegExp(signature)}"$`,
      "m",
    ),
  );
  if (!match) {
    throw new Error(`extern signature not found: ${signature}`);
  }
  return match[1];
}

function parsePushOperand(line: string): string {
  const match = line.match(/^PUSH,\s+(.+)$/);
  if (!match) {
    throw new Error(`not a PUSH line: ${line}`);
  }
  return match[1];
}

function parseUasmLines(uasm: string): string[] {
  return uasm
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function findExternIndexBySignature(
  uasm: string,
  signature: string,
): {
  lines: string[];
  externLine: string;
  externIndex: number;
} {
  const externSymbol = findExternSymbolBySignature(uasm, signature);
  const lines = parseUasmLines(uasm);
  const externLine = `EXTERN, ${externSymbol}`;
  const externIndices = lines
    .map((line, index) => (line === externLine ? index : -1))
    .filter((index) => index >= 0);
  if (externIndices.length === 0) {
    throw new Error(`extern call not found: ${externLine}`);
  }
  if (externIndices.length !== 1) {
    throw new Error(
      `expected exactly 1 extern call for ${externLine}, got ${externIndices.length}`,
    );
  }
  const externIndex = externIndices[0];
  return { lines, externLine, externIndex };
}

// This helper intentionally assumes a codegen-specific PUSH-PUSH-PUSH layout
// immediately before each comparison EXTERN. Keeping this strict makes the test
// fail loudly if UASM structure changes (e.g. non-contiguous argument pushes).
function findComparisonArgs(uasm: string, signature: string): [string, string] {
  const { lines, externLine, externIndex } = findExternIndexBySignature(
    uasm,
    signature,
  );

  if (externIndex < 3) {
    throw new Error(`not enough instructions before ${externLine}`);
  }

  const pushLines = [
    lines[externIndex - 3],
    lines[externIndex - 2],
    lines[externIndex - 1],
  ];
  for (const pushLine of pushLines) {
    if (!pushLine.startsWith("PUSH, ")) {
      throw new Error(
        `expected contiguous PUSH instructions before ${externLine}, got: ${pushLines.join(" | ")}`,
      );
    }
  }

  const pushes = pushLines.map(parsePushOperand);
  return [pushes[0], pushes[1]];
}

// resolveOperandAtExtern traces COPY aliases backward from a comparison EXTERN:
// 1) findExternIndexBySignature gets `lines` and `externIndex`.
// 2) Starting at `externIndex - 3`, scan backward for PUSH-PUSH-COPY where the
//    first push is "PUSH, <current>", the second starts with "PUSH, ", and the
//    third line is "COPY".
// 3) parsePushOperand extracts the second PUSH operand as the next symbol.
// 4) Repeat until no prior chain exists, then return the resolved symbol.
// Index checks of `i + 1` / `i + 2` enforce the exact PUSH-PUSH-COPY pattern.
function resolveOperandAtExtern(
  uasm: string,
  signature: string,
  sourceSymbol: string,
): string {
  const { lines, externIndex } = findExternIndexBySignature(uasm, signature);
  let current = sourceSymbol;
  const visited = new Set<string>();
  const maxIterations = lines.length + 1;
  let iterations = 0;

  while (iterations < maxIterations) {
    if (visited.has(current)) {
      throw new Error(
        `cyclic COPY chain detected while resolving ${sourceSymbol}`,
      );
    }
    visited.add(current);
    iterations += 1;

    let nextSymbol: string | null = null;
    for (let i = externIndex - 3; i >= 0; i -= 1) {
      if (lines[i] !== `PUSH, ${current}`) continue;
      if (!lines[i + 1]?.startsWith("PUSH, ")) continue;
      if (lines[i + 2] !== "COPY") continue;
      nextSymbol = parsePushOperand(lines[i + 1]);
      break;
    }
    if (!nextSymbol) {
      return current;
    }
    current = nextSymbol;
  }

  throw new Error(
    `COPY chain exceeded ${maxIterations} steps while resolving ${sourceSymbol}`,
  );
}

describe("comparison operator codegen regression", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  for (const optimize of [false, true] as const) {
    it(`keeps consistent operand order for <, >, <=, >= (optimize=${optimize})`, () => {
      const uasm = new TypeScriptToUdonTranspiler().transpile(SOURCE, {
        optimize,
      }).uasm;

      const ltArgs = findComparisonArgs(uasm, OP_SIGNATURES.lt);
      const gtArgs = findComparisonArgs(uasm, OP_SIGNATURES.gt);
      const leArgs = findComparisonArgs(uasm, OP_SIGNATURES.le);
      const geArgs = findComparisonArgs(uasm, OP_SIGNATURES.ge);
      const lhsOperand = resolveOperandAtExtern(
        uasm,
        OP_SIGNATURES.lt,
        "lhsValue",
      );
      const rhsOperand = resolveOperandAtExtern(
        uasm,
        OP_SIGNATURES.lt,
        "rhsValue",
      );

      expect(ltArgs[0]).toBe(lhsOperand);
      expect(ltArgs[1]).toBe(rhsOperand);
      expect(gtArgs[0]).toBe(lhsOperand);
      expect(gtArgs[1]).toBe(rhsOperand);
      expect(leArgs[0]).toBe(lhsOperand);
      expect(leArgs[1]).toBe(rhsOperand);
      expect(geArgs[0]).toBe(lhsOperand);
      expect(geArgs[1]).toBe(rhsOperand);
    });
  }
});

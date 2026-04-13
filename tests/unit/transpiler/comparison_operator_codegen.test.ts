import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

const SOURCE = `
  import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
  import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
  import type { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
  import { Debug } from "@ootr/udon-assembly-ts/stubs/UnityTypes";

  @UdonBehaviour()
  export class ComparisonOrderTest extends UdonSharpBehaviour {
    private pick(v: UdonInt): UdonInt {
      return v;
    }

    Start(): void {
      const lhs: UdonInt = this.pick(1 as UdonInt);
      const rhs: UdonInt = this.pick(2 as UdonInt);
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

function findComparisonArgs(uasm: string, signature: string): [string, string] {
  const externSymbol = findExternSymbolBySignature(uasm, signature);
  const lines = uasm
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const externLine = `EXTERN, ${externSymbol}`;
  const externIndex = lines.indexOf(externLine);
  if (externIndex < 0) {
    throw new Error(`extern call not found: ${externLine}`);
  }

  const pushes: string[] = [];
  for (let i = externIndex - 1; i >= 0 && pushes.length < 3; i -= 1) {
    if (!lines[i].startsWith("PUSH, ")) continue;
    pushes.unshift(parsePushOperand(lines[i]));
  }

  if (pushes.length !== 3) {
    throw new Error(
      `expected 3 PUSH operands before ${externLine}, got ${pushes.length}`,
    );
  }

  return [pushes[0], pushes[1]];
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

      expect(ltArgs[0]).not.toBe(ltArgs[1]);
      expect(gtArgs).toEqual(ltArgs);
      expect(leArgs).toEqual(ltArgs);
      expect(geArgs).toEqual(ltArgs);
    });
  }
});

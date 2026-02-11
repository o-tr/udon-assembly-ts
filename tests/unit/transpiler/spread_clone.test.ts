import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import { ASTToTACConverter } from "../../../src/transpiler/ir/ast_to_tac/index.js";
import {
  type LabelInstruction,
  type MethodCallInstruction,
  type TACInstruction,
  TACInstructionKind,
} from "../../../src/transpiler/ir/tac_instruction.js";
import type { LabelOperand } from "../../../src/transpiler/ir/tac_operand.js";

function getTACInstructions(source: string): TACInstruction[] {
  const parser = new TypeScriptParser();
  const ast = parser.parse(source);
  const converter = new ASTToTACConverter(
    parser.getSymbolTable(),
    parser.getEnumRegistry(),
  );
  return converter.convert(ast);
}

function hasMethodCall(
  instructions: TACInstruction[],
  method: string,
): boolean {
  return instructions.some(
    (inst) =>
      inst.kind === TACInstructionKind.MethodCall &&
      (inst as MethodCallInstruction).method === method,
  );
}

function countMethodCalls(
  instructions: TACInstruction[],
  method: string,
): number {
  return instructions.filter(
    (inst) =>
      inst.kind === TACInstructionKind.MethodCall &&
      (inst as MethodCallInstruction).method === method,
  ).length;
}

function hasLabel(instructions: TACInstruction[], prefix: string): boolean {
  return instructions.some(
    (inst) =>
      inst.kind === TACInstructionKind.Label &&
      ((inst as LabelInstruction).label as LabelOperand).name.startsWith(
        prefix,
      ),
  );
}

describe("spread clone optimization", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("{...obj} uses ShallowClone", () => {
    const tac = getTACInstructions(`
      let obj: DataDictionary = new DataDictionary();
      let copy = {...obj};
    `);
    expect(hasMethodCall(tac, "ShallowClone")).toBe(true);
    expect(hasMethodCall(tac, "Merge")).toBe(false);
    expect(hasLabel(tac, "merge_outer")).toBe(false);
  });

  it("{...obj, key: val} uses ShallowClone + SetValue", () => {
    const tac = getTACInstructions(`
      let obj: DataDictionary = new DataDictionary();
      let copy = {...obj, key: "value"};
    `);
    expect(hasMethodCall(tac, "ShallowClone")).toBe(true);
    expect(hasMethodCall(tac, "SetValue")).toBe(true);
    expect(hasMethodCall(tac, "Merge")).toBe(false);
    expect(hasLabel(tac, "merge_outer")).toBe(false);
  });

  it("{...obj, a: 1, b: 2} uses ShallowClone + 2x SetValue", () => {
    const tac = getTACInstructions(`
      let obj: DataDictionary = new DataDictionary();
      let copy = {...obj, a: 1, b: 2};
    `);
    expect(hasMethodCall(tac, "ShallowClone")).toBe(true);
    expect(countMethodCalls(tac, "SetValue")).toBeGreaterThanOrEqual(2);
    expect(hasMethodCall(tac, "Merge")).toBe(false);
    expect(hasLabel(tac, "merge_outer")).toBe(false);
  });

  it("{...a, ...b} falls back to merge path", () => {
    const tac = getTACInstructions(`
      let a: DataDictionary = new DataDictionary();
      let b: DataDictionary = new DataDictionary();
      let copy = {...a, ...b};
    `);
    expect(hasMethodCall(tac, "ShallowClone")).toBe(false);
    const hasMerge =
      hasMethodCall(tac, "Merge") || hasLabel(tac, "merge_outer");
    expect(hasMerge).toBe(true);
  });

  it("{key: 'old', ...obj} falls back to merge path", () => {
    const tac = getTACInstructions(`
      let obj: DataDictionary = new DataDictionary();
      let copy = {key: "old", ...obj};
    `);
    expect(hasMethodCall(tac, "ShallowClone")).toBe(false);
    const hasMerge =
      hasMethodCall(tac, "Merge") || hasLabel(tac, "merge_outer");
    expect(hasMerge).toBe(true);
  });

  it("{...obj} with only spread produces no SetValue", () => {
    const tac = getTACInstructions(`
      let obj: DataDictionary = new DataDictionary();
      let copy = {...obj};
    `);
    expect(hasMethodCall(tac, "ShallowClone")).toBe(true);
    expect(countMethodCalls(tac, "SetValue")).toBe(0);
  });
});

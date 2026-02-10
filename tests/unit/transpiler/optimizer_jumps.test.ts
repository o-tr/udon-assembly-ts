import { describe, expect, it } from "vitest";
import { PrimitiveTypes } from "../../../src/transpiler/frontend/type_symbols";
import { simplifyJumps } from "../../../src/transpiler/ir/optimizer/passes/jumps";
import {
  ConditionalJumpInstruction,
  LabelInstruction,
  ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnconditionalJumpInstruction,
} from "../../../src/transpiler/ir/tac_instruction";
import {
  createConstant,
  createLabel,
  type LabelOperand,
  TACOperandKind,
} from "../../../src/transpiler/ir/tac_operand";

const stringify = (insts: { toString(): string }[]) =>
  insts.map((inst) => inst.toString()).join("\n");

const findMissingLabels = (instructions: TACInstruction[]): string[] => {
  const defined = new Set<string>();
  const referenced = new Set<string>();

  for (const inst of instructions) {
    if (inst.kind === TACInstructionKind.Label) {
      const label = (inst as LabelInstruction).label;
      if (label.kind === TACOperandKind.Label) {
        defined.add((label as LabelOperand).name);
      }
      continue;
    }

    if (inst.kind === TACInstructionKind.UnconditionalJump) {
      const label = (inst as UnconditionalJumpInstruction).label;
      if (label.kind === TACOperandKind.Label) {
        referenced.add((label as LabelOperand).name);
      }
      continue;
    }

    if (inst.kind === TACInstructionKind.ConditionalJump) {
      const label = (inst as ConditionalJumpInstruction).label;
      if (label.kind === TACOperandKind.Label) {
        referenced.add((label as LabelOperand).name);
      }
    }
  }

  return [...referenced].filter((name) => !defined.has(name));
};

describe("jump simplification", () => {
  it("rewrites jumps targeting alias labels that are removed", () => {
    const instructions = [
      new UnconditionalJumpInstruction(createLabel("else6")),
      new LabelInstruction(createLabel("from2")),
      new UnconditionalJumpInstruction(createLabel("else6")),
      new LabelInstruction(createLabel("else6")),
      new LabelInstruction(createLabel("else7")),
      new ReturnInstruction(),
    ];

    const optimized = simplifyJumps(instructions);
    const text = stringify(optimized);

    expect(text).toContain("goto else7");
    expect(text).not.toContain("goto else6");
    expect(text).not.toContain("else6:");
    expect(findMissingLabels(optimized)).toEqual([]);
  });

  it("rewrites conditional jumps targeting alias labels that are removed", () => {
    const instructions = [
      new ConditionalJumpInstruction(
        createConstant(false, PrimitiveTypes.boolean),
        createLabel("endif6"),
      ),
      new ReturnInstruction(),
      new LabelInstruction(createLabel("endif6")),
      new LabelInstruction(createLabel("endif7")),
      new ReturnInstruction(),
    ];

    const optimized = simplifyJumps(instructions);
    const text = stringify(optimized);

    expect(text).toContain("goto endif7");
    expect(text).not.toContain("goto endif6");
    expect(text).not.toContain("endif6:");
    expect(findMissingLabels(optimized)).toEqual([]);
  });
});

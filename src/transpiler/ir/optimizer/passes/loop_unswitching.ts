import {
  ConditionalJumpInstruction,
  LabelInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import {
  createLabel,
  type LabelOperand,
  TACOperandKind,
} from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import {
  getDefinedOperandForReuse,
  getMaxTempId,
  getUsedOperandsForReuse,
} from "../utils/instructions.js";
import { livenessKey } from "../utils/liveness.js";
import { collectLoops } from "./licm.js";

const MAX_LOOP_INSTRUCTIONS = 20;

export const unswitchLoops = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  const loops = collectLoops(cfg);
  if (loops.length === 0) return instructions;

  // Collect all definitions in each loop
  for (const loop of loops) {
    const loopDefKeys = new Set<string>();
    let loopInstructionCount = 0;

    for (const blockId of loop.blocks) {
      const block = cfg.blocks[blockId];
      for (let i = block.start; i <= block.end; i++) {
        loopInstructionCount++;
        const defOp = getDefinedOperandForReuse(instructions[i]);
        const defKey = livenessKey(defOp);
        if (defKey) loopDefKeys.add(defKey);
      }
    }

    if (loopInstructionCount > MAX_LOOP_INSTRUCTIONS) continue;

    // Find conditional jumps in the loop with loop-invariant conditions
    for (const blockId of loop.blocks) {
      const block = cfg.blocks[blockId];
      for (let i = block.start; i <= block.end; i++) {
        const inst = instructions[i];
        if (inst.kind !== TACInstructionKind.ConditionalJump) continue;

        const condJump = inst as ConditionalJumpInstruction;
        const condKey = livenessKey(condJump.condition);

        // Check if condition is loop-invariant
        // It's invariant if it's a constant or defined outside the loop
        const isConstant =
          condJump.condition.kind === TACOperandKind.Constant;
        const isInvariant =
          isConstant || (condKey !== null && !loopDefKeys.has(condKey));

        if (!isInvariant) continue;

        // Check if the target label is inside the loop
        if (condJump.label.kind !== TACOperandKind.Label) continue;
        const targetLabelName = (condJump.label as LabelOperand).name;
        let targetInLoop = false;
        for (const loopBlockId of loop.blocks) {
          const loopBlock = cfg.blocks[loopBlockId];
          for (let j = loopBlock.start; j <= loopBlock.end; j++) {
            const loopInst = instructions[j];
            if (loopInst.kind === TACInstructionKind.Label) {
              const labelInst = loopInst as LabelInstruction;
              if (
                labelInst.label.kind === TACOperandKind.Label &&
                (labelInst.label as LabelOperand).name === targetLabelName
              ) {
                targetInLoop = true;
              }
            }
          }
        }
        if (!targetInLoop) continue;

        // Found an unswitchable conditional. Perform the transformation.
        return performUnswitch(
          instructions,
          loop,
          cfg,
          i,
          condJump,
        );
      }
    }
  }

  return instructions;
};

const performUnswitch = (
  instructions: TACInstruction[],
  loop: { headerId: number; blocks: Set<number>; preheaderId: number },
  cfg: { blocks: Array<{ id: number; start: number; end: number; preds: number[]; succs: number[] }> },
  condJumpIndex: number,
  condJump: ConditionalJumpInstruction,
): TACInstruction[] => {
  // Collect all loop instructions in order
  const loopIndices: number[] = [];
  const sortedBlockIds = Array.from(loop.blocks).sort((a, b) => {
    return cfg.blocks[a].start - cfg.blocks[b].start;
  });
  for (const blockId of sortedBlockIds) {
    const block = cfg.blocks[blockId];
    for (let i = block.start; i <= block.end; i++) {
      loopIndices.push(i);
    }
  }

  const loopIndexSet = new Set(loopIndices);
  let maxTempId = getMaxTempId(instructions);

  // Collect label names used in the loop for renaming
  const loopLabelNames = new Set<string>();
  for (const idx of loopIndices) {
    const inst = instructions[idx];
    if (inst.kind === TACInstructionKind.Label) {
      const labelInst = inst as LabelInstruction;
      if (labelInst.label.kind === TACOperandKind.Label) {
        loopLabelNames.add((labelInst.label as LabelOperand).name);
      }
    }
  }

  // Create clone with renamed labels
  const suffix = `_us${++maxTempId}`;
  const cloneLabel = (name: string): string => {
    if (loopLabelNames.has(name)) return `${name}${suffix}`;
    return name;
  };

  const cloneInstruction = (inst: TACInstruction): TACInstruction => {
    if (inst.kind === TACInstructionKind.Label) {
      const labelInst = inst as LabelInstruction;
      if (labelInst.label.kind === TACOperandKind.Label) {
        const name = (labelInst.label as LabelOperand).name;
        return new LabelInstruction(createLabel(cloneLabel(name)));
      }
    }
    if (inst.kind === TACInstructionKind.ConditionalJump) {
      const cond = inst as ConditionalJumpInstruction;
      if (cond.label.kind === TACOperandKind.Label) {
        const name = (cond.label as LabelOperand).name;
        return new ConditionalJumpInstruction(
          cond.condition,
          createLabel(cloneLabel(name)),
        );
      }
    }
    if (inst.kind === TACInstructionKind.UnconditionalJump) {
      const jump = inst as UnconditionalJumpInstruction;
      if (jump.label.kind === TACOperandKind.Label) {
        const name = (jump.label as LabelOperand).name;
        return new UnconditionalJumpInstruction(
          createLabel(cloneLabel(name)),
        );
      }
    }
    return inst;
  };

  // Build two copies of the loop body:
  // Clone A: original loop body (then path - condition was true, so no jump)
  // Clone B: cloned loop body (else path - condition was false, jumped)
  const cloneA: TACInstruction[] = [];
  const cloneB: TACInstruction[] = [];

  for (const idx of loopIndices) {
    const inst = instructions[idx];
    // In clone A, keep everything as-is (the conditional jump stays)
    cloneA.push(inst);
    // In clone B, rename labels
    cloneB.push(cloneInstruction(inst));
  }

  // Find the header label for clone B
  const headerBlock = cfg.blocks[loop.headerId];
  const headerInst = instructions[headerBlock.start];
  let cloneBHeaderLabel: string | null = null;
  if (headerInst.kind === TACInstructionKind.Label) {
    const labelInst = headerInst as LabelInstruction;
    if (labelInst.label.kind === TACOperandKind.Label) {
      cloneBHeaderLabel = cloneLabel(
        (labelInst.label as LabelOperand).name,
      );
    }
  }

  if (!cloneBHeaderLabel) return instructions;

  // Build the result:
  // 1. Everything before the loop
  // 2. ifFalse condition goto clone_B_header
  // 3. Clone A (original loop)
  // 4. Clone B (renamed loop)
  // 5. Everything after the loop
  const result: TACInstruction[] = [];

  // Pre-loop instructions
  for (let i = 0; i < instructions.length; i++) {
    if (loopIndexSet.has(i)) continue;
    // Insert the unswitched conditional and clones before the first loop instruction
    if (i === loopIndices[0]) {
      // Unswitch: check condition before entering the loop
      result.push(
        new ConditionalJumpInstruction(
          condJump.condition,
          createLabel(cloneBHeaderLabel),
        ),
      );
      // Clone A (original loop)
      for (const inst of cloneA) {
        result.push(inst);
      }
      // Clone B (renamed loop)
      for (const inst of cloneB) {
        result.push(inst);
      }
    }
    result.push(instructions[i]);
  }

  // If the loop was at the very end, we might have missed adding clones
  if (!result.some((inst) => inst === cloneA[0])) {
    result.push(
      new ConditionalJumpInstruction(
        condJump.condition,
        createLabel(cloneBHeaderLabel),
      ),
    );
    for (const inst of cloneA) result.push(inst);
    for (const inst of cloneB) result.push(inst);
  }

  return result;
};

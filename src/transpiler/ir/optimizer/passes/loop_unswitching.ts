import {
  ConditionalJumpInstruction,
  LabelInstruction,
  type TACInstruction,
  TACInstructionKind,
  UnconditionalJumpInstruction,
  PhiInstruction,
  CopyInstruction,
} from "../../tac_instruction.js";
import {
  createLabel,
  type LabelOperand,
  TACOperandKind,
  createTemporary,
} from "../../tac_operand.js";
import { createTemporary } from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import {
  getDefinedOperandForReuse,
  getMaxTempId,
  getUsedOperandsForReuse,
} from "../utils/instructions.js";
import { rewriteOperands } from "../utils/instructions.js";
import { livenessKey } from "../utils/liveness.js";
import { collectLoops } from "./licm.js";
import { operandKey } from "../utils/operands.js";

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

    // Phi lowering: if the header contains Phi nodes, lower them by inserting
    // copies into each predecessor. This removes Phi instructions and makes
    // cloning simpler (avoids SSA/Phi rewriting).
    const headerBlock = cfg.blocks[loop.headerId];
    const headerPhis: { index: number; inst: PhiInstruction }[] = [];
    for (let i = headerBlock.start; i <= headerBlock.end; i++) {
      const inst = instructions[i];
      if (inst.kind === TACInstructionKind.Phi) {
        headerPhis.push({ index: i, inst: inst as PhiInstruction });
      }
    }
    if (headerPhis.length > 0) {
      // Build insertion plan per predecessor
      const inserts = new Map<number, TACInstruction[]>();
      let nextTempId = getMaxTempId(instructions) + 1;

      const insertBeforeTerminator = (
        block: { start: number; end: number },
        _instructions: TACInstruction[],
      ): number => {
        const last = _instructions[block.end];
        if (
          last.kind === TACInstructionKind.UnconditionalJump ||
          last.kind === TACInstructionKind.ConditionalJump ||
          last.kind === TACInstructionKind.Return
        ) {
          return block.end;
        }
        return block.end + 1;
      };

      const emitParallelCopies = (
        plans: Array<{ dest: any; src: any }>,
      ): { insts: TACInstruction[]; nextTempId: number } => {
        const insts: TACInstruction[] = [];
        const pending = new Map<string, any>();
        const destKeys = new Set<string>();
        for (const p of plans) {
          const dk = operandKey(p.dest);
          pending.set(dk, p);
          destKeys.add(dk);
        }

        while (pending.size > 0) {
          let progress = false;
          for (const [dk, p] of Array.from(pending.entries())) {
            const srcKey = operandKey(p.src);
            if (!destKeys.has(srcKey)) {
              insts.push(new CopyInstruction(p.dest, p.src));
              pending.delete(dk);
              destKeys.delete(dk);
              progress = true;
            }
          }
          if (progress) continue;
          // Cycle exists: break with temp
          const [[dk, p]] = Array.from(pending.entries());
          const temp = createTemporary(nextTempId++, p.src.type);
          insts.push(new CopyInstruction(temp, p.src));
          // replace any pending entry whose src equals p.dest with temp
          for (const [k, q] of Array.from(pending.entries())) {
            if (operandKey(q.src) === dk) {
              pending.set(k, { dest: q.dest, src: temp });
            }
          }
        }
        return { insts, nextTempId };
      };

      for (const predId of headerBlock.preds) {
        const predBlock = cfg.blocks[predId];
        const plans: Array<{ dest: any; src: any }> = [];
        for (const { inst: phi } of headerPhis) {
          const src = phi.sources.find((s) => s.pred === predId)?.value;
          if (!src) {
            // Missing source for this predecessor; bail out conservatively
            inserts.clear();
            break;
          }
          plans.push({ dest: phi.dest, src });
        }
        if (inserts.size === 0 && plans.length !== headerPhis.length) break;
        if (plans.length === 0) continue;
        const insertIndex = insertBeforeTerminator(predBlock, instructions);
        const { insts, nextTempId: nt } = emitParallelCopies(plans);
        nextTempId = nt;
        const existing = inserts.get(insertIndex) ?? [];
        inserts.set(insertIndex, existing.concat(insts));
      }

      if (inserts.size === 0) {
        // couldn't lower phis safely; skip this loop
        continue;
      }

      // Apply insertions into instructions array (splicing)
      // Sort insert indices descending to avoid shifting earlier indices
      const insertEntries = Array.from(inserts.entries()).sort((a, b) => b[0] - a[0]);
      const work = instructions.slice();
      for (const [idx, insts] of insertEntries) {
        work.splice(idx + 1, 0, ...insts);
      }
      // Remove phi instructions from header in work
      for (let i = headerBlock.end; i >= headerBlock.start; i--) {
        if (work[i].kind === TACInstructionKind.Phi) work.splice(i, 1);
      }
      // Replace instructions with lowered version and rebuild cfg & loop data
      instructions = work;
      // rebuild cfg / loop indices after structural change
      // Note: We will restart outer loop to re-discover loops with updated instructions
      return unswitchLoops(instructions);
    }

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

  // Conservative safety: if the loop contains Phi or side-effectful
  // instructions (calls, method calls, property sets, array assignments),
  // skip unswitching to avoid complex SSA/Phi rewriting.
  for (const idx of loopIndices) {
    const inst = instructions[idx];
    if (
      inst.kind === TACInstructionKind.Phi ||
      inst.kind === TACInstructionKind.Call ||
      inst.kind === TACInstructionKind.MethodCall ||
      inst.kind === TACInstructionKind.PropertySet ||
      inst.kind === TACInstructionKind.ArrayAssignment
    ) {
      return instructions;
    }
  }

  // Remap temporaries inside cloneB so we don't create duplicate temp ids
  const tempMap = new Map<number, number>();
  let nextTempId = maxTempId + 1;
  for (const inst of cloneB) {
    rewriteOperands(inst, (op: any) => {
      if (op && op.kind === TACOperandKind.Temporary) {
        const oldId = op.id as number;
        if (!tempMap.has(oldId)) {
          tempMap.set(oldId, nextTempId++);
        }
        return createTemporary(tempMap.get(oldId) as number, op.type);
      }
      return op;
    });
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
  let inserted = false;
  for (let i = 0; i < instructions.length; i++) {
    // Insert the unswitched conditional and clones at the original loop position
    if (!inserted && i === loopIndices[0]) {
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
      inserted = true;
    }

    if (loopIndexSet.has(i)) continue;

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

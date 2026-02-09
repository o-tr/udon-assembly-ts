import {
  type TACInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import { TACOperandKind } from "../../tac_operand.js";
import { buildCFG } from "../analysis/cfg.js";
import {
  getDefinedOperandForReuse,
  getUsedOperandsForReuse,
  isPureProducer,
} from "../utils/instructions.js";
import { livenessKey } from "../utils/liveness.js";

/**
 * Code sinking: move pure computations closer to their only use.
 * If a value is computed in a block with multiple successors but only
 * used in one successor, sink it into that successor.
 */
export const sinkCode = (instructions: TACInstruction[]): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  // Build a map from liveness key to all instruction indices that use it
  const useLocations = new Map<string, Set<number>>();
  for (let i = 0; i < instructions.length; i++) {
    for (const op of getUsedOperandsForReuse(instructions[i])) {
      const key = livenessKey(op);
      if (!key) continue;
      const set = useLocations.get(key) ?? new Set();
      set.add(i);
      useLocations.set(key, set);
    }
  }

  // Map instruction index → block id
  const instToBlock = new Map<number, number>();
  for (const block of cfg.blocks) {
    for (let i = block.start; i <= block.end; i++) {
      instToBlock.set(i, block.id);
    }
  }

  // Collect sink candidates: instruction index → target block id
  const sinkTargets = new Map<number, number>();

  for (const block of cfg.blocks) {
    if (block.succs.length < 2) continue;

    // Get the terminator instruction to check if its operands are used
    const terminator = instructions[block.end];
    const terminatorUsedKeys = new Set<string>();
    for (const op of getUsedOperandsForReuse(terminator)) {
      const key = livenessKey(op);
      if (key) terminatorUsedKeys.add(key);
    }

    for (let i = block.start; i <= block.end; i++) {
      const inst = instructions[i];
      if (!isPureProducer(inst)) continue;

      const def = getDefinedOperandForReuse(inst);
      if (!def) continue;
      const defKey = livenessKey(def);
      if (!defKey) continue;

      // Don't sink if the result is used by this block's terminator
      if (terminatorUsedKeys.has(defKey)) continue;

      // Find all uses of this definition
      const uses = useLocations.get(defKey);
      if (!uses || uses.size === 0) continue;

      // Check if all uses are in exactly one successor block
      const useBlocks = new Set<number>();
      for (const useIdx of uses) {
        const useBlockId = instToBlock.get(useIdx);
        if (useBlockId !== undefined) {
          useBlocks.add(useBlockId);
        }
      }

      // Remove the current block (the definition itself may appear as a "use" in a self-referencing case)
      useBlocks.delete(block.id);

      if (useBlocks.size !== 1) continue;

      const targetBlockId = useBlocks.values().next().value;
      if (targetBlockId === undefined) continue;

      // Verify the target is a successor
      if (!block.succs.includes(targetBlockId)) continue;

      // Verify operands of the instruction are available in the target block
      // Variables are always available; temps must be defined before the target block
      let operandsAvailable = true;
      for (const op of getUsedOperandsForReuse(inst)) {
        if (
          op.kind === TACOperandKind.Constant ||
          op.kind === TACOperandKind.Label ||
          op.kind === TACOperandKind.Variable
        ) {
          continue;
        }
        // For temps, check they're not defined in this block after or at current instruction
        // (they should be defined before in this block or in a predecessor)
        const opKey = livenessKey(op);
        if (!opKey) {
          operandsAvailable = false;
          break;
        }
        // Check the operand isn't being sunk too (can't sink both at once)
        let definedBeforeInBlock = false;
        for (let j = block.start; j < i; j++) {
          const jDef = getDefinedOperandForReuse(instructions[j]);
          if (jDef && livenessKey(jDef) === opKey) {
            // Check if this definition is also being sunk
            if (sinkTargets.has(j)) {
              operandsAvailable = false;
              break;
            }
            definedBeforeInBlock = true;
            break;
          }
        }
        if (!operandsAvailable) break;
        // If defined in a predecessor or parameter, it's available
        if (!definedBeforeInBlock) {
          // Check if defined in some other (preceding) block — assume available
          // since the CFG guarantees dominance for well-formed TAC
          continue;
        }
      }
      if (!operandsAvailable) continue;

      sinkTargets.set(i, targetBlockId);
    }
  }

  if (sinkTargets.size === 0) return instructions;

  // Build a map of block start → instructions to insert
  const insertions = new Map<number, TACInstruction[]>();
  for (const [instIdx, blockId] of sinkTargets) {
    const targetBlock = cfg.blocks[blockId];
    const list = insertions.get(targetBlock.start) ?? [];
    list.push(instructions[instIdx]);
    insertions.set(targetBlock.start, list);
  }

  // Rebuild instruction list
  const result: TACInstruction[] = [];
  for (let i = 0; i < instructions.length; i++) {
    // Insert sunk instructions after any labels at the target block start
    const pending = insertions.get(i);
    if (pending) {
      // Find where labels end at the target block start
      let labelEnd = i;
      while (
        labelEnd < instructions.length &&
        instructions[labelEnd].kind === TACInstructionKind.Label
      ) {
        result.push(instructions[labelEnd]);
        labelEnd++;
      }
      // Insert sunk instructions after labels
      result.push(...pending);
      // Skip the labels we already pushed (back up by 1 because the for loop will increment)
      if (labelEnd > i) {
        i = labelEnd - 1;
        continue;
      }
    }

    // Skip sunk instructions from their original position
    if (sinkTargets.has(i)) continue;

    result.push(instructions[i]);
  }

  return result;
};

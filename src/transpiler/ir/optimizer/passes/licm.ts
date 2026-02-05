import type { TACInstruction } from "../../tac_instruction.js";
import type { BasicBlock } from "../analysis/cfg.js";
import { buildCFG, isBlockTerminator } from "../analysis/cfg.js";
import {
  getDefinedOperandForReuse,
  getUsedOperandsForReuse,
  isPureProducer,
} from "../utils/instructions.js";
import { livenessKey } from "../utils/liveness.js";
import { numberSetEqual } from "../utils/sets.js";

export const computeDominators = (cfg: {
  blocks: BasicBlock[];
}): Map<number, Set<number>> => {
  const dom = new Map<number, Set<number>>();
  const all = new Set<number>(cfg.blocks.map((block) => block.id));

  for (const block of cfg.blocks) {
    if (block.id === 0) {
      dom.set(block.id, new Set([block.id]));
    } else {
      dom.set(block.id, new Set(all));
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const block of cfg.blocks) {
      if (block.id === 0) continue;
      const preds = block.preds;
      if (preds.length === 0) continue;
      let intersection = new Set<number>(dom.get(preds[0]) ?? []);
      for (let i = 1; i < preds.length; i++) {
        const predDom = dom.get(preds[i]) ?? new Set<number>();
        intersection = new Set(
          Array.from(intersection).filter((id) => predDom.has(id)),
        );
      }
      intersection.add(block.id);
      const current = dom.get(block.id) ?? new Set<number>();
      if (!numberSetEqual(current, intersection)) {
        dom.set(block.id, intersection);
        changed = true;
      }
    }
  }

  return dom;
};

export const collectLoops = (cfg: {
  blocks: BasicBlock[];
}): Array<{
  headerId: number;
  blocks: Set<number>;
  preheaderId: number;
}> => {
  const dom = computeDominators(cfg);
  const loopsByHeader = new Map<number, Set<number>>();

  for (const block of cfg.blocks) {
    for (const succ of block.succs) {
      const doms = dom.get(block.id);
      if (doms?.has(succ)) {
        const loop = new Set<number>([succ, block.id]);
        const stack = [block.id];
        while (stack.length > 0) {
          const current = stack.pop() as number;
          if (current === succ) continue;
          const preds = cfg.blocks[current].preds;
          for (const pred of preds) {
            if (!loop.has(pred)) {
              loop.add(pred);
              stack.push(pred);
            }
          }
        }
        const existing = loopsByHeader.get(succ);
        if (existing) {
          for (const id of loop) existing.add(id);
        } else {
          loopsByHeader.set(succ, loop);
        }
      }
    }
  }

  const loops: Array<{
    headerId: number;
    blocks: Set<number>;
    preheaderId: number;
  }> = [];
  for (const [headerId, blocks] of loopsByHeader.entries()) {
    const headerBlock = cfg.blocks[headerId];
    const externalPreds = headerBlock.preds.filter((id) => !blocks.has(id));
    if (externalPreds.length !== 1) continue;
    loops.push({
      headerId,
      blocks,
      preheaderId: externalPreds[0],
    });
  }
  return loops;
};

export const preheaderInsertIndex = (
  preheader: BasicBlock,
  instructions: TACInstruction[],
): number => {
  if (preheader.end < preheader.start) return preheader.start;
  const last = instructions[preheader.end];
  if (last && isBlockTerminator(last)) {
    return preheader.end;
  }
  return preheader.end + 1;
};

const orderHoistedByDeps = (
  hoisted: TACInstruction[],
  preheaderDefKeys: Set<string>,
): { ordered: TACInstruction[]; defined: Set<string> } => {
  const defKeys = new Map<TACInstruction, string | null>();
  const defKeySet = new Set<string>();
  for (const inst of hoisted) {
    const defKey = livenessKey(getDefinedOperandForReuse(inst));
    defKeys.set(inst, defKey ?? null);
    if (defKey) defKeySet.add(defKey);
  }

  const remaining = hoisted.slice();
  const ordered: TACInstruction[] = [];
  const defined = new Set(preheaderDefKeys);

  let progress = true;
  while (remaining.length > 0 && progress) {
    progress = false;
    for (let i = 0; i < remaining.length; ) {
      const inst = remaining[i];
      const deps = new Set(
        getUsedOperandsForReuse(inst)
          .map((op) => livenessKey(op))
          .filter((key): key is string => !!key && defKeySet.has(key)),
      );
      let ready = true;
      for (const dep of deps) {
        if (!defined.has(dep)) {
          ready = false;
          break;
        }
      }
      if (ready) {
        ordered.push(inst);
        const defKey = defKeys.get(inst);
        if (defKey) defined.add(defKey);
        remaining.splice(i, 1);
        progress = true;
      } else {
        i += 1;
      }
    }
  }

  return { ordered, defined };
};

export const performLICM = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  const loops = collectLoops(cfg);
  if (loops.length === 0) return instructions;

  const dom = computeDominators(cfg);
  const indexToBlock = new Map<number, number>();
  for (const block of cfg.blocks) {
    for (let i = block.start; i <= block.end; i++) {
      indexToBlock.set(i, block.id);
    }
  }

  const hoistMap = new Map<number, TACInstruction[]>();
  const hoistIndices = new Set<number>();
  const preheaderDefKeys = new Map<number, Set<string>>();

  for (const loop of loops) {
    const loopBlocks = loop.blocks;
    const preheader = cfg.blocks[loop.preheaderId];
    const preheaderInsert = preheaderInsertIndex(preheader, instructions);

    const loopDefKeys = new Set<string>();
    const defCounts = new Map<string, number>();
    const loopIndices: number[] = [];

    for (const blockId of loopBlocks) {
      const block = cfg.blocks[blockId];
      for (let i = block.start; i <= block.end; i++) {
        loopIndices.push(i);
        const defOp = getDefinedOperandForReuse(instructions[i]);
        const defKey = livenessKey(defOp);
        if (defKey) {
          loopDefKeys.add(defKey);
          defCounts.set(defKey, (defCounts.get(defKey) ?? 0) + 1);
        }
      }
    }

    const loopIndexSet = new Set(loopIndices);
    const useBeforeDef = new Map<string, number>();
    for (const index of loopIndices) {
      const inst = instructions[index];
      for (const op of getUsedOperandsForReuse(inst)) {
        const key = livenessKey(op);
        if (!key) continue;
        const existing = useBeforeDef.get(key);
        if (existing === undefined || index < existing) {
          useBeforeDef.set(key, index);
        }
      }
    }

    const usedOutside = new Set<string>();
    for (let i = 0; i < instructions.length; i++) {
      if (loopIndexSet.has(i)) continue;
      for (const op of getUsedOperandsForReuse(instructions[i])) {
        const key = livenessKey(op);
        if (key) usedOutside.add(key);
      }
    }

    const candidates: Array<{ index: number; inst: TACInstruction }> = [];
    for (const index of loopIndices) {
      const inst = instructions[index];
      if (!isPureProducer(inst)) continue;
      const defined = getDefinedOperandForReuse(inst);
      const defKey = livenessKey(defined);
      if (!defKey) continue;
      if ((defCounts.get(defKey) ?? 0) !== 1) continue;
      if (usedOutside.has(defKey)) continue;
      if ((useBeforeDef.get(defKey) ?? index) < index) continue;

      const defBlockId = indexToBlock.get(index);
      if (defBlockId === undefined) continue;
      let dominatesLoop = true;
      for (const blockId of loopBlocks) {
        if (!(dom.get(blockId)?.has(defBlockId) ?? false)) {
          dominatesLoop = false;
          break;
        }
      }
      if (!dominatesLoop) continue;

      const operands = getUsedOperandsForReuse(inst);
      const allInvariant = operands.every((op) => {
        const key = livenessKey(op);
        if (!key) return true;
        return !loopDefKeys.has(key);
      });
      if (!allInvariant) continue;
      candidates.push({ index, inst });
    }

    if (candidates.length === 0) continue;

    candidates.sort((a, b) => a.index - b.index);

    const hoisted = candidates.map((candidate) => candidate.inst);
    if (hoisted.length > 0) {
      const existing = hoistMap.get(preheaderInsert) ?? [];
      const existingDefs = preheaderDefKeys.get(preheaderInsert) ?? new Set();
      const { ordered, defined } = orderHoistedByDeps(hoisted, existingDefs);
      if (ordered.length > 0) {
        hoistMap.set(preheaderInsert, existing.concat(ordered));
        preheaderDefKeys.set(preheaderInsert, defined);
        const orderedSet = new Set(ordered);
        for (const candidate of candidates) {
          if (orderedSet.has(candidate.inst)) {
            hoistIndices.add(candidate.index);
          }
        }
      }
    }
  }

  if (hoistIndices.size === 0) return instructions;

  const result: TACInstruction[] = [];
  for (let i = 0; i < instructions.length; i++) {
    const inserts = hoistMap.get(i);
    if (inserts) {
      result.push(...inserts);
    }
    if (hoistIndices.has(i)) continue;
    result.push(instructions[i]);
  }

  const tailInserts = hoistMap.get(instructions.length);
  if (tailInserts) {
    result.push(...tailInserts);
  }

  return result;
};

import type { TACInstruction } from "../../tac_instruction.js";
import type { BasicBlock } from "../analysis/cfg.js";
import { buildCFG, isBlockTerminator } from "../analysis/cfg.js";
import {
  getDefinedOperandForReuse,
  getUsedOperandsForReuse,
  isPureProducer,
} from "../utils/instructions.js";
import { livenessKey } from "../utils/liveness.js";

type CFG = { blocks: BasicBlock[] };

/**
 * Compute reverse postorder numbering via iterative DFS.
 * Only reachable blocks from entry (block 0) are included.
 */
export const computeRPO = (cfg: CFG): number[] => {
  const visited = new Set<number>();
  const postorder: number[] = [];

  // Iterative DFS using explicit stack
  // Stack entries: [blockId, childIndex]
  const stack: Array<[number, number]> = [[0, 0]];
  visited.add(0);

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const blockId = top[0];
    const childIdx = top[1];
    const succs = cfg.blocks[blockId].succs;

    if (childIdx < succs.length) {
      top[1] = childIdx + 1;
      const succ = succs[childIdx];
      if (!visited.has(succ)) {
        visited.add(succ);
        stack.push([succ, 0]);
      }
    } else {
      stack.pop();
      postorder.push(blockId);
    }
  }

  postorder.reverse();
  return postorder;
};

/**
 * Cooper-Harvey-Kennedy algorithm for computing immediate dominators.
 * RPO-based fixpoint iteration. Entry block's idom = entry block itself.
 * Memory: O(N).
 */
export const computeIDom = (cfg: CFG): Map<number, number> => {
  const rpo = computeRPO(cfg);
  const rpoNumber = new Map<number, number>();
  for (let i = 0; i < rpo.length; i++) {
    rpoNumber.set(rpo[i], i);
  }

  const entryId = rpo[0];
  const idom = new Map<number, number>();
  idom.set(entryId, entryId);

  const intersect = (b1: number, b2: number): number => {
    let finger1 = b1;
    let finger2 = b2;
    while (finger1 !== finger2) {
      while ((rpoNumber.get(finger1) ?? 0) > (rpoNumber.get(finger2) ?? 0)) {
        finger1 = idom.get(finger1) as number;
      }
      while ((rpoNumber.get(finger2) ?? 0) > (rpoNumber.get(finger1) ?? 0)) {
        finger2 = idom.get(finger2) as number;
      }
    }
    return finger1;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < rpo.length; i++) {
      const blockId = rpo[i];
      const preds = cfg.blocks[blockId].preds;

      // Find first predecessor with an idom entry
      let newIdom: number | undefined;
      for (const pred of preds) {
        if (idom.has(pred)) {
          newIdom = pred;
          break;
        }
      }
      if (newIdom === undefined) continue;

      // Intersect with remaining processed predecessors
      for (const pred of preds) {
        if (pred === newIdom) continue;
        if (idom.has(pred)) {
          newIdom = intersect(newIdom, pred);
        }
      }

      if (idom.get(blockId) !== newIdom) {
        idom.set(blockId, newIdom);
        changed = true;
      }
    }
  }

  return idom;
};

/**
 * Build dominator tree timestamps via iterative DFS on the dominator tree.
 * Returns tin/tout maps for O(1) dominance queries.
 */
export const buildDomTimestamps = (
  idom: Map<number, number>,
  entryId: number,
): { tin: Map<number, number>; tout: Map<number, number> } => {
  // Build children lists from idom
  const children = new Map<number, number[]>();
  for (const [child, parent] of idom.entries()) {
    if (child === parent) continue; // Skip entry self-reference
    let kids = children.get(parent);
    if (!kids) {
      kids = [];
      children.set(parent, kids);
    }
    kids.push(child);
  }

  const tin = new Map<number, number>();
  const tout = new Map<number, number>();
  let time = 0;

  // Iterative DFS: stack entries [blockId, childIndex]
  const stack: Array<[number, number]> = [[entryId, 0]];
  tin.set(entryId, time++);

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const blockId = top[0];
    const childIdx = top[1];
    const kids = children.get(blockId) ?? [];

    if (childIdx < kids.length) {
      top[1] = childIdx + 1;
      const child = kids[childIdx];
      tin.set(child, time++);
      stack.push([child, 0]);
    } else {
      stack.pop();
      tout.set(blockId, time++);
    }
  }

  return { tin, tout };
};

/**
 * O(1) dominance check using Euler tour timestamps.
 * Returns true if `a` dominates `b`.
 * Returns false if either block has no timestamp (unreachable).
 */
export const dominates = (
  tin: Map<number, number>,
  tout: Map<number, number>,
  a: number,
  b: number,
): boolean => {
  const tinA = tin.get(a);
  const tinB = tin.get(b);
  if (tinA === undefined || tinB === undefined) return false;
  const toutA = tout.get(a);
  const toutB = tout.get(b);
  if (toutA === undefined || toutB === undefined) return false;
  return tinA <= tinB && toutB <= toutA;
};

export const collectLoops = (
  cfg: CFG,
): {
  loops: Array<{
    headerId: number;
    blocks: Set<number>;
    preheaderId: number;
  }>;
  idom: Map<number, number>;
  tin: Map<number, number>;
  tout: Map<number, number>;
} => {
  const idom = computeIDom(cfg);
  const { tin, tout } = buildDomTimestamps(idom, 0);
  const loopsByHeader = new Map<number, Set<number>>();

  for (const block of cfg.blocks) {
    for (const succ of block.succs) {
      if (dominates(tin, tout, succ, block.id)) {
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
  return { loops, idom, tin, tout };
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

  const { loops, tin, tout } = collectLoops(cfg);
  if (loops.length === 0) return instructions;
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
        if (!dominates(tin, tout, defBlockId, blockId)) {
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

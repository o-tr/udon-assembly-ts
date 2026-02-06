import type { TACInstruction } from "../../tac_instruction.js";
import {
  type LabelInstruction,
  TACInstructionKind,
  type UnconditionalJumpInstruction,
} from "../../tac_instruction.js";
import type { LabelOperand } from "../../tac_operand.js";
import { TACOperandKind } from "../../tac_operand.js";
import type { BasicBlock } from "../analysis/cfg.js";
import { buildCFG } from "../analysis/cfg.js";

type Chain = {
  id: number;
  blocks: number[];
  head: number;
};

const buildLabelToBlock = (
  blocks: BasicBlock[],
  instructions: TACInstruction[],
): Map<string, number> => {
  const labelToBlock = new Map<string, number>();
  for (const block of blocks) {
    for (let i = block.start; i <= block.end; i += 1) {
      const inst = instructions[i];
      if (inst.kind !== TACInstructionKind.Label) continue;
      const labelInst = inst as LabelInstruction;
      if (labelInst.label.kind !== TACOperandKind.Label) continue;
      labelToBlock.set((labelInst.label as LabelOperand).name, block.id);
    }
  }
  return labelToBlock;
};

const hasFallthrough = (
  block: BasicBlock,
  instructions: TACInstruction[],
): boolean => {
  const lastInst = instructions[block.end];
  return (
    lastInst.kind !== TACInstructionKind.UnconditionalJump &&
    lastInst.kind !== TACInstructionKind.Return
  );
};

const getUnconditionalTarget = (
  block: BasicBlock,
  instructions: TACInstruction[],
  labelToBlock: Map<string, number>,
): number | undefined => {
  const lastInst = instructions[block.end];
  if (lastInst.kind !== TACInstructionKind.UnconditionalJump) return undefined;
  const label = (lastInst as UnconditionalJumpInstruction).label;
  if (label.kind !== TACOperandKind.Label) return undefined;
  return labelToBlock.get((label as LabelOperand).name);
};

const buildChains = (
  blocks: BasicBlock[],
  instructions: TACInstruction[],
): { chains: Chain[]; blockToChain: number[] } => {
  const fallthroughTargets = new Set<number>();
  for (const block of blocks) {
    if (!hasFallthrough(block, instructions)) continue;
    const fallthrough = block.id + 1;
    if (fallthrough < blocks.length) {
      fallthroughTargets.add(fallthrough);
    }
  }

  const chains: Chain[] = [];
  const blockToChain = new Array<number>(blocks.length).fill(-1);

  for (let i = 0; i < blocks.length; i += 1) {
    if (fallthroughTargets.has(i)) continue;
    const chainBlocks: number[] = [];
    let current = i;
    while (current < blocks.length) {
      chainBlocks.push(current);
      if (!hasFallthrough(blocks[current], instructions)) break;
      const next = current + 1;
      if (next >= blocks.length) break;
      current = next;
    }
    const chainId = chains.length;
    chains.push({ id: chainId, blocks: chainBlocks, head: chainBlocks[0] });
    for (const blockId of chainBlocks) {
      blockToChain[blockId] = chainId;
    }
  }

  for (let i = 0; i < blocks.length; i += 1) {
    if (blockToChain[i] !== -1) continue;
    const chainBlocks: number[] = [];
    let current = i;
    while (current < blocks.length && blockToChain[current] === -1) {
      chainBlocks.push(current);
      if (!hasFallthrough(blocks[current], instructions)) break;
      const next = current + 1;
      if (next >= blocks.length || blockToChain[next] !== -1) break;
      current = next;
    }
    const chainId = chains.length;
    chains.push({ id: chainId, blocks: chainBlocks, head: chainBlocks[0] });
    for (const blockId of chainBlocks) {
      blockToChain[blockId] = chainId;
    }
  }

  return { chains, blockToChain };
};

const orderChains = (
  chains: Chain[],
  blockToChain: number[],
  instructions: TACInstruction[],
  blocks: BasicBlock[],
): number[] => {
  const labelToBlock = buildLabelToBlock(blocks, instructions);
  const ordered: number[] = [];
  const placed = new Set<number>();

  const appendChain = (chainId: number): void => {
    if (placed.has(chainId)) return;
    placed.add(chainId);
    ordered.push(chainId);
  };

  const entryChain = blockToChain[0] !== -1 ? blockToChain[0] : 0;
  appendChain(entryChain);

  while (ordered.length < chains.length) {
    const currentChainId = ordered[ordered.length - 1];
    const currentChain = chains[currentChainId];
    const lastBlockId = currentChain.blocks[currentChain.blocks.length - 1];
    const targetBlock = getUnconditionalTarget(
      blocks[lastBlockId],
      instructions,
      labelToBlock,
    );
    const targetChainId =
      targetBlock !== undefined ? blockToChain[targetBlock] : undefined;
    if (targetChainId !== undefined && !placed.has(targetChainId)) {
      appendChain(targetChainId);
      continue;
    }

    let appended = false;
    for (const chain of chains) {
      if (!placed.has(chain.id)) {
        appendChain(chain.id);
        appended = true;
        break;
      }
    }

    if (!appended) break;
  }

  return ordered;
};

export const optimizeBlockLayout = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  if (instructions.length === 0) return instructions;

  const { blocks } = buildCFG(instructions);
  if (blocks.length <= 1) return instructions;

  const { chains, blockToChain } = buildChains(blocks, instructions);
  if (chains.length <= 1) return instructions;

  const chainOrder = orderChains(chains, blockToChain, instructions, blocks);

  const result: TACInstruction[] = [];
  for (const chainId of chainOrder) {
    const chain = chains[chainId];
    for (const blockId of chain.blocks) {
      const block = blocks[blockId];
      for (let i = block.start; i <= block.end; i += 1) {
        result.push(instructions[i]);
      }
    }
  }

  return result;
};

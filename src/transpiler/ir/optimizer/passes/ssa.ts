import {
  AssignmentInstruction,
  PhiInstruction as PhiInst,
  type PhiInstruction,
  type PhiSource,
  type TACInstruction,
  TACInstructionKind,
} from "../../tac_instruction.js";
import {
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
} from "../../tac_operand.js";
import { buildCFG, isBlockTerminator } from "../analysis/cfg.js";
import { getDefinedOperandForReuse } from "../utils/instructions.js";
import { computeDominators } from "./licm.js";

type BlockInsts = Map<number, TACInstruction[]>;

type VersionedOperand = TACOperand & { ssaVersion?: number };

type DomTree = Map<number, number[]>;

type BlockInfo = {
  labels: TACInstruction[];
  body: TACInstruction[];
  phis: PhiInstruction[];
};

const isLabel = (inst: TACInstruction): boolean =>
  inst.kind === TACInstructionKind.Label;

const baseKeyForOperand = (operand: TACOperand | undefined): string | null => {
  if (!operand) return null;
  if (operand.kind === TACOperandKind.Variable) {
    const variable = operand as VariableOperand;
    return `v:${variable.name}`;
  }
  if (operand.kind === TACOperandKind.Temporary) {
    const temp = operand as TemporaryOperand;
    return `t:${temp.id}`;
  }
  return null;
};

const cloneBaseOperand = (operand: TACOperand): TACOperand => {
  if (operand.kind === TACOperandKind.Variable) {
    return { ...(operand as VariableOperand) };
  }
  if (operand.kind === TACOperandKind.Temporary) {
    return { ...(operand as TemporaryOperand) };
  }
  return operand;
};

const cloneWithVersion = (
  operand: TACOperand,
  version: number,
): VersionedOperand => {
  if (operand.kind === TACOperandKind.Variable) {
    const variable = operand as VariableOperand;
    return { ...variable, ssaVersion: version };
  }
  if (operand.kind === TACOperandKind.Temporary) {
    const temp = operand as TemporaryOperand;
    return { ...temp, ssaVersion: version };
  }
  return operand as VersionedOperand;
};

const stripVersion = (operand: TACOperand): TACOperand => {
  if (operand.kind === TACOperandKind.Variable) {
    const { ssaVersion: _ignored, ...rest } = operand as VersionedOperand &
      VariableOperand;
    return rest;
  }
  if (operand.kind === TACOperandKind.Temporary) {
    const { ssaVersion: _ignored, ...rest } = operand as VersionedOperand &
      TemporaryOperand;
    return rest;
  }
  return operand;
};

const rewriteUsedOperands = (
  inst: TACInstruction,
  rewrite: (operand: TACOperand) => TACOperand,
): void => {
  switch (inst.kind) {
    case TACInstructionKind.Assignment:
    case TACInstructionKind.Copy:
    case TACInstructionKind.Cast: {
      const typed = inst as unknown as { src: TACOperand };
      typed.src = rewrite(typed.src);
      return;
    }
    case TACInstructionKind.BinaryOp: {
      const bin = inst as unknown as { left: TACOperand; right: TACOperand };
      bin.left = rewrite(bin.left);
      bin.right = rewrite(bin.right);
      return;
    }
    case TACInstructionKind.UnaryOp: {
      const unary = inst as unknown as { operand: TACOperand };
      unary.operand = rewrite(unary.operand);
      return;
    }
    case TACInstructionKind.ConditionalJump: {
      const cond = inst as unknown as { condition: TACOperand };
      cond.condition = rewrite(cond.condition);
      return;
    }
    case TACInstructionKind.Call: {
      const call = inst as unknown as { args: TACOperand[] };
      call.args = call.args.map(rewrite);
      return;
    }
    case TACInstructionKind.MethodCall: {
      const method = inst as unknown as {
        object: TACOperand;
        args: TACOperand[];
      };
      method.object = rewrite(method.object);
      method.args = method.args.map(rewrite);
      return;
    }
    case TACInstructionKind.PropertyGet: {
      const get = inst as unknown as { object: TACOperand };
      get.object = rewrite(get.object);
      return;
    }
    case TACInstructionKind.PropertySet: {
      const set = inst as unknown as {
        object: TACOperand;
        value: TACOperand;
      };
      set.object = rewrite(set.object);
      set.value = rewrite(set.value);
      return;
    }
    case TACInstructionKind.Return: {
      const ret = inst as unknown as { value?: TACOperand };
      if (ret.value) ret.value = rewrite(ret.value);
      return;
    }
    case TACInstructionKind.ArrayAccess: {
      const acc = inst as unknown as {
        array: TACOperand;
        index: TACOperand;
      };
      acc.array = rewrite(acc.array);
      acc.index = rewrite(acc.index);
      return;
    }
    case TACInstructionKind.ArrayAssignment: {
      const assign = inst as unknown as {
        array: TACOperand;
        index: TACOperand;
        value: TACOperand;
      };
      assign.array = rewrite(assign.array);
      assign.index = rewrite(assign.index);
      assign.value = rewrite(assign.value);
      return;
    }
    default:
      return;
  }
};

const setDefinedOperand = (
  inst: TACInstruction,
  replacement: TACOperand,
): void => {
  switch (inst.kind) {
    case TACInstructionKind.Assignment:
    case TACInstructionKind.Copy:
    case TACInstructionKind.BinaryOp:
    case TACInstructionKind.UnaryOp:
    case TACInstructionKind.Cast:
    case TACInstructionKind.PropertyGet:
    case TACInstructionKind.ArrayAccess: {
      (inst as unknown as { dest: TACOperand }).dest = replacement;
      return;
    }
    case TACInstructionKind.Call:
    case TACInstructionKind.MethodCall: {
      if ((inst as { dest?: TACOperand }).dest) {
        (inst as { dest?: TACOperand }).dest = replacement;
      }
      return;
    }
    case TACInstructionKind.Phi: {
      (inst as unknown as { dest: TACOperand }).dest = replacement;
      return;
    }
    default:
      return;
  }
};

const computeDominanceFrontiers = (
  cfg: ReturnType<typeof buildCFG>,
  dom: Map<number, Set<number>>,
): Map<number, Set<number>> => {
  const blocks = cfg.blocks.map((block) => block.id);
  const frontiers = new Map<number, Set<number>>();
  for (const id of blocks) frontiers.set(id, new Set());

  for (const block of cfg.blocks) {
    if (block.preds.length < 2) continue;
    for (const pred of block.preds) {
      for (const candidate of blocks) {
        if (
          dom.get(pred)?.has(candidate) &&
          (candidate === block.id || !dom.get(block.id)?.has(candidate))
        ) {
          frontiers.get(candidate)?.add(block.id);
        }
      }
    }
  }

  return frontiers;
};

const computeDomTree = (
  cfg: ReturnType<typeof buildCFG>,
  dom: Map<number, Set<number>>,
): DomTree => {
  const idom = new Map<number, number | null>();
  idom.set(0, null);

  for (const block of cfg.blocks) {
    if (block.id === 0) continue;
    const strict = new Set(dom.get(block.id) ?? []);
    strict.delete(block.id);
    let candidate: number | null = null;
    for (const d of strict) {
      let isImmediate = true;
      for (const other of strict) {
        if (other === d) continue;
        if (dom.get(other)?.has(d)) {
          isImmediate = false;
          break;
        }
      }
      if (isImmediate) {
        candidate = d;
        break;
      }
    }
    idom.set(block.id, candidate);
  }

  const tree: DomTree = new Map();
  for (const block of cfg.blocks) {
    tree.set(block.id, []);
  }
  for (const [blockId, parent] of idom.entries()) {
    if (parent === null || parent === undefined) continue;
    tree.get(parent)?.push(blockId);
  }
  return tree;
};

const splitBlockInstructions = (
  insts: TACInstruction[],
  phis: PhiInstruction[],
): BlockInfo => {
  const labels: TACInstruction[] = [];
  const body: TACInstruction[] = [];
  let inLabels = true;
  for (const inst of insts) {
    if (inLabels && isLabel(inst)) {
      labels.push(inst);
    } else {
      inLabels = false;
      if (inst.kind !== TACInstructionKind.Phi) {
        body.push(inst);
      }
    }
  }
  return { labels, body, phis };
};

const operandType = (operand: TACOperand): { udonType: string } => {
  if (operand.kind === TACOperandKind.Variable) {
    return (operand as VariableOperand).type;
  }
  if (operand.kind === TACOperandKind.Temporary) {
    return (operand as TemporaryOperand).type;
  }
  if (operand.kind === TACOperandKind.Constant) {
    return (operand as unknown as { type: { udonType: string } }).type;
  }
  return { udonType: "Single" };
};

const operandKey = (operand: TACOperand): string => {
  if (operand.kind === TACOperandKind.Variable) {
    const variable = operand as VersionedOperand & VariableOperand;
    return `v:${variable.name}:${variable.ssaVersion ?? ""}`;
  }
  if (operand.kind === TACOperandKind.Temporary) {
    const temp = operand as VersionedOperand & TemporaryOperand;
    return `t:${temp.id}:${temp.ssaVersion ?? ""}`;
  }
  if (operand.kind === TACOperandKind.Constant) {
    const constant = operand as unknown as {
      value: unknown;
      type: { udonType: string };
    };
    return `c:${JSON.stringify(constant.value)}:${constant.type.udonType}`;
  }
  return `o:${operand.kind}`;
};

const collectTemps = (instructions: TACInstruction[]): number => {
  let maxId = -1;
  const check = (operand: TACOperand | undefined) => {
    if (!operand) return;
    if (operand.kind === TACOperandKind.Temporary) {
      maxId = Math.max(maxId, (operand as TemporaryOperand).id);
    }
  };

  for (const inst of instructions) {
    switch (inst.kind) {
      case TACInstructionKind.Assignment:
      case TACInstructionKind.Copy:
      case TACInstructionKind.Cast: {
        const typed = inst as unknown as { dest: TACOperand; src: TACOperand };
        check(typed.dest);
        check(typed.src);
        break;
      }
      case TACInstructionKind.BinaryOp: {
        const bin = inst as unknown as {
          dest: TACOperand;
          left: TACOperand;
          right: TACOperand;
        };
        check(bin.dest);
        check(bin.left);
        check(bin.right);
        break;
      }
      case TACInstructionKind.UnaryOp: {
        const unary = inst as unknown as {
          dest: TACOperand;
          operand: TACOperand;
        };
        check(unary.dest);
        check(unary.operand);
        break;
      }
      case TACInstructionKind.Call: {
        const call = inst as unknown as {
          dest?: TACOperand;
          args: TACOperand[];
        };
        check(call.dest);
        for (const arg of call.args) check(arg);
        break;
      }
      case TACInstructionKind.MethodCall: {
        const method = inst as unknown as {
          dest?: TACOperand;
          object: TACOperand;
          args: TACOperand[];
        };
        check(method.dest);
        check(method.object);
        for (const arg of method.args) check(arg);
        break;
      }
      case TACInstructionKind.PropertyGet: {
        const get = inst as unknown as {
          dest: TACOperand;
          object: TACOperand;
        };
        check(get.dest);
        check(get.object);
        break;
      }
      case TACInstructionKind.PropertySet: {
        const set = inst as unknown as {
          object: TACOperand;
          value: TACOperand;
        };
        check(set.object);
        check(set.value);
        break;
      }
      case TACInstructionKind.Return: {
        const ret = inst as unknown as { value?: TACOperand };
        check(ret.value);
        break;
      }
      case TACInstructionKind.ArrayAccess: {
        const acc = inst as unknown as {
          dest: TACOperand;
          array: TACOperand;
          index: TACOperand;
        };
        check(acc.dest);
        check(acc.array);
        check(acc.index);
        break;
      }
      case TACInstructionKind.ArrayAssignment: {
        const assign = inst as unknown as {
          array: TACOperand;
          index: TACOperand;
          value: TACOperand;
        };
        check(assign.array);
        check(assign.index);
        check(assign.value);
        break;
      }
      case TACInstructionKind.ConditionalJump: {
        const cond = inst as unknown as { condition: TACOperand };
        check(cond.condition);
        break;
      }
      case TACInstructionKind.UnconditionalJump: {
        const jump = inst as unknown as { label: TACOperand };
        check(jump.label);
        break;
      }
      case TACInstructionKind.Phi: {
        const phi = inst as PhiInstruction;
        check(phi.dest);
        for (const source of phi.sources) check(source.value);
        break;
      }
      default:
        break;
    }
  }

  return maxId + 1;
};

type ParallelMove = { dest: TACOperand; src: TACOperand };

const linearizeParallelCopies = (
  moves: ParallelMove[],
  createTemp: (source: TACOperand) => TACOperand,
): AssignmentInstruction[] => {
  const pending = moves.map((move) => ({ ...move }));
  const emitted: AssignmentInstruction[] = [];
  const moveKey = (operand: TACOperand): string => {
    const baseKey = baseKeyForOperand(operand);
    return baseKey ?? operandKey(operand);
  };

  while (pending.length > 0) {
    const sourceKeys = new Set(pending.map((move) => moveKey(move.src)));
    const readyIndex = pending.findIndex(
      (move) => !sourceKeys.has(moveKey(move.dest)),
    );

    if (readyIndex >= 0) {
      const [move] = pending.splice(readyIndex, 1);
      emitted.push(new AssignmentInstruction(move.dest, move.src));
      continue;
    }

    const cycleMove = pending[0];
    const temp = createTemp(cycleMove.src);
    emitted.push(new AssignmentInstruction(temp, cycleMove.src));
    const srcKey = moveKey(cycleMove.src);
    for (const move of pending) {
      if (moveKey(move.src) === srcKey) {
        move.src = temp;
      }
    }
  }

  return emitted;
};

const insertPhis = (
  cfg: ReturnType<typeof buildCFG>,
  instructions: TACInstruction[],
): { blocks: BlockInsts; phis: Map<number, PhiInstruction[]> } => {
  const dom = computeDominators(cfg);
  const frontiers = computeDominanceFrontiers(cfg, dom);

  const defBlocks = new Map<string, Set<number>>();
  const baseOperand = new Map<string, TACOperand>();

  for (const block of cfg.blocks) {
    for (let i = block.start; i <= block.end; i++) {
      const def = getDefinedOperandForReuse(instructions[i]);
      const key = baseKeyForOperand(def);
      if (!key || !def) continue;
      if (!defBlocks.has(key)) defBlocks.set(key, new Set());
      defBlocks.get(key)?.add(block.id);
      if (!baseOperand.has(key)) baseOperand.set(key, def);
    }
  }

  const phiByBlock = new Map<number, PhiInstruction[]>();
  for (const block of cfg.blocks) {
    phiByBlock.set(block.id, []);
  }

  for (const [key, defs] of defBlocks.entries()) {
    const worklist = Array.from(defs);
    const hasPhi = new Set<number>();
    while (worklist.length > 0) {
      const current = worklist.pop();
      if (current === undefined) continue;
      const frontier = frontiers.get(current);
      if (!frontier) continue;
      for (const target of frontier) {
        if (hasPhi.has(target)) continue;
        hasPhi.add(target);
        const baseDest = baseOperand.get(key);
        if (!baseDest) continue;
        const dest = cloneBaseOperand(baseDest);
        const sources: PhiSource[] = cfg.blocks[target].preds.map((pred) => ({
          pred,
          value: cloneBaseOperand(baseDest),
        }));
        phiByBlock.get(target)?.push(new PhiInst(dest, sources));
        if (!defs.has(target)) {
          worklist.push(target);
        }
      }
    }
  }

  const blockInsts: BlockInsts = new Map();
  for (const block of cfg.blocks) {
    const slice = instructions.slice(block.start, block.end + 1);
    const phis = phiByBlock.get(block.id) ?? [];
    const info = splitBlockInstructions(slice, phis);
    blockInsts.set(block.id, [...info.labels, ...info.phis, ...info.body]);
  }

  return { blocks: blockInsts, phis: phiByBlock };
};

const renameBlocks = (
  cfg: ReturnType<typeof buildCFG>,
  blocks: BlockInsts,
  phiByBlock: Map<number, PhiInstruction[]>,
): void => {
  const dom = computeDominators(cfg);
  const domTree = computeDomTree(cfg, dom);
  const stacks = new Map<string, TACOperand[]>();
  const counters = new Map<string, number>();

  const newVersion = (operand: TACOperand): TACOperand => {
    const key = baseKeyForOperand(operand);
    if (!key) return operand;
    const count = counters.get(key) ?? 0;
    counters.set(key, count + 1);
    return cloneWithVersion(operand, count);
  };

  const pushStack = (key: string, operand: TACOperand) => {
    if (!stacks.has(key)) stacks.set(key, []);
    stacks.get(key)?.push(operand);
  };

  const popStack = (key: string) => {
    const stack = stacks.get(key);
    if (!stack || stack.length === 0) return;
    stack.pop();
  };

  const peekStack = (key: string): TACOperand | null => {
    const stack = stacks.get(key);
    if (!stack || stack.length === 0) return null;
    return stack[stack.length - 1] ?? null;
  };

  const renameBlock = (blockId: number) => {
    const insts = blocks.get(blockId) ?? [];
    const definedKeys: string[] = [];

    const phis = phiByBlock.get(blockId) ?? [];
    for (const phi of phis) {
      const key = baseKeyForOperand(phi.dest);
      if (!key) continue;
      const versioned = newVersion(phi.dest);
      setDefinedOperand(phi, versioned);
      pushStack(key, versioned);
      definedKeys.push(key);
    }

    for (const inst of insts) {
      if (inst.kind === TACInstructionKind.Label) continue;
      if (inst.kind === TACInstructionKind.Phi) continue;
      rewriteUsedOperands(inst, (operand) => {
        const key = baseKeyForOperand(operand);
        if (!key) return operand;
        return peekStack(key) ?? operand;
      });
      const def = getDefinedOperandForReuse(inst);
      const key = baseKeyForOperand(def);
      if (def && key) {
        const versioned = newVersion(def);
        setDefinedOperand(inst, versioned);
        pushStack(key, versioned);
        definedKeys.push(key);
      }
    }

    const succs = cfg.blocks[blockId]?.succs ?? [];
    for (const succ of succs) {
      const succPhis = phiByBlock.get(succ) ?? [];
      for (const phi of succPhis) {
        const key = baseKeyForOperand(phi.dest);
        if (!key) continue;
        const top = peekStack(key);
        const source = phi.sources.find((entry) => entry.pred === blockId);
        if (source) {
          source.value = top ?? source.value;
        }
      }
    }

    const children = domTree.get(blockId) ?? [];
    for (const child of children) {
      renameBlock(child);
    }

    for (let i = definedKeys.length - 1; i >= 0; i--) {
      popStack(definedKeys[i]);
    }
  };

  renameBlock(0);
};

const stripSsaVersions = (instructions: TACInstruction[]): TACInstruction[] => {
  for (const inst of instructions) {
    switch (inst.kind) {
      case TACInstructionKind.Assignment:
      case TACInstructionKind.Copy:
      case TACInstructionKind.Cast: {
        const typed = inst as unknown as { dest: TACOperand; src: TACOperand };
        typed.dest = stripVersion(typed.dest);
        typed.src = stripVersion(typed.src);
        break;
      }
      case TACInstructionKind.BinaryOp: {
        const bin = inst as unknown as {
          dest: TACOperand;
          left: TACOperand;
          right: TACOperand;
        };
        bin.dest = stripVersion(bin.dest);
        bin.left = stripVersion(bin.left);
        bin.right = stripVersion(bin.right);
        break;
      }
      case TACInstructionKind.UnaryOp: {
        const unary = inst as unknown as {
          dest: TACOperand;
          operand: TACOperand;
        };
        unary.dest = stripVersion(unary.dest);
        unary.operand = stripVersion(unary.operand);
        break;
      }
      case TACInstructionKind.Call: {
        const call = inst as unknown as {
          dest?: TACOperand;
          args: TACOperand[];
        };
        if (call.dest) call.dest = stripVersion(call.dest);
        call.args = call.args.map(stripVersion);
        break;
      }
      case TACInstructionKind.MethodCall: {
        const method = inst as unknown as {
          dest?: TACOperand;
          object: TACOperand;
          args: TACOperand[];
        };
        if (method.dest) method.dest = stripVersion(method.dest);
        method.object = stripVersion(method.object);
        method.args = method.args.map(stripVersion);
        break;
      }
      case TACInstructionKind.PropertyGet: {
        const get = inst as unknown as {
          dest: TACOperand;
          object: TACOperand;
        };
        get.dest = stripVersion(get.dest);
        get.object = stripVersion(get.object);
        break;
      }
      case TACInstructionKind.PropertySet: {
        const set = inst as unknown as {
          object: TACOperand;
          value: TACOperand;
        };
        set.object = stripVersion(set.object);
        set.value = stripVersion(set.value);
        break;
      }
      case TACInstructionKind.Return: {
        const ret = inst as unknown as { value?: TACOperand };
        if (ret.value) ret.value = stripVersion(ret.value);
        break;
      }
      case TACInstructionKind.ArrayAccess: {
        const acc = inst as unknown as {
          dest: TACOperand;
          array: TACOperand;
          index: TACOperand;
        };
        acc.dest = stripVersion(acc.dest);
        acc.array = stripVersion(acc.array);
        acc.index = stripVersion(acc.index);
        break;
      }
      case TACInstructionKind.ArrayAssignment: {
        const assign = inst as unknown as {
          array: TACOperand;
          index: TACOperand;
          value: TACOperand;
        };
        assign.array = stripVersion(assign.array);
        assign.index = stripVersion(assign.index);
        assign.value = stripVersion(assign.value);
        break;
      }
      case TACInstructionKind.ConditionalJump: {
        const cond = inst as unknown as { condition: TACOperand };
        cond.condition = stripVersion(cond.condition);
        break;
      }
      case TACInstructionKind.UnconditionalJump: {
        const jump = inst as unknown as { label: TACOperand };
        jump.label = stripVersion(jump.label);
        break;
      }
      case TACInstructionKind.Phi: {
        const phi = inst as PhiInstruction;
        phi.dest = stripVersion(phi.dest);
        phi.sources = phi.sources.map((source) => ({
          pred: source.pred,
          value: stripVersion(source.value),
        }));
        break;
      }
      default:
        break;
    }
  }
  return instructions;
};

export const buildSSA = (instructions: TACInstruction[]): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  const { blocks, phis } = insertPhis(cfg, instructions);
  renameBlocks(cfg, blocks, phis);

  const ordered: TACInstruction[] = [];
  for (const block of cfg.blocks) {
    const insts = blocks.get(block.id);
    if (insts) ordered.push(...insts);
  }

  return ordered;
};

export const deconstructSSA = (
  instructions: TACInstruction[],
): TACInstruction[] => {
  const cfg = buildCFG(instructions);
  if (cfg.blocks.length === 0) return instructions;

  const blocks: BlockInsts = new Map();
  let nextTempId = collectTemps(instructions);
  const createTemp = (source: TACOperand): TACOperand => {
    const type = operandType(source);
    const temp = {
      kind: TACOperandKind.Temporary,
      id: nextTempId,
      type,
    } as TemporaryOperand;
    nextTempId += 1;
    return temp;
  };

  for (const block of cfg.blocks) {
    const slice = instructions.slice(block.start, block.end + 1);
    const phis = slice.filter(
      (inst): inst is PhiInstruction => inst.kind === TACInstructionKind.Phi,
    );
    const info = splitBlockInstructions(slice, phis);
    blocks.set(block.id, [...info.labels, ...info.phis, ...info.body]);
  }

  for (const block of cfg.blocks) {
    const insts = blocks.get(block.id) ?? [];
    const phis = insts.filter(
      (inst): inst is PhiInstruction => inst.kind === TACInstructionKind.Phi,
    );
    if (phis.length === 0) continue;

    const movesByPred = new Map<number, ParallelMove[]>();
    for (const phi of phis) {
      for (const source of phi.sources) {
        const moves = movesByPred.get(source.pred) ?? [];
        moves.push({ dest: phi.dest, src: source.value });
        movesByPred.set(source.pred, moves);
      }
    }

    for (const [predId, moves] of movesByPred.entries()) {
      const predInsts = blocks.get(predId);
      if (!predInsts || moves.length === 0) continue;
      let insertIndex = predInsts.length;
      for (let i = predInsts.length - 1; i >= 0; i--) {
        if (isBlockTerminator(predInsts[i])) {
          insertIndex = i;
        }
      }
      const lowered = linearizeParallelCopies(moves, createTemp);
      if (lowered.length > 0) {
        predInsts.splice(insertIndex, 0, ...lowered);
      }
    }

    blocks.set(
      block.id,
      insts.filter((inst) => inst.kind !== TACInstructionKind.Phi),
    );
  }

  const ordered: TACInstruction[] = [];
  for (const block of cfg.blocks) {
    const insts = blocks.get(block.id);
    if (insts) ordered.push(...insts);
  }

  return stripSsaVersions(ordered);
};

export const applySSA = (instructions: TACInstruction[]): TACInstruction[] => {
  const ssa = buildSSA(instructions);
  if (!ssa.some((inst) => inst.kind === TACInstructionKind.Phi)) {
    return stripSsaVersions(ssa);
  }
  return deconstructSSA(ssa);
};

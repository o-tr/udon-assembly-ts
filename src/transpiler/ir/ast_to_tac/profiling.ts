/**
 * Inline-expansion profiling instrumentation.
 *
 * Gated on UDON_PROFILE=1 — when off, every public function early-returns
 * before touching state, and the converter fields stay null. The
 * compile-time `PROF` constant lets V8 inline the no-op branch into the
 * call site.
 *
 * Records:
 *   - inlineHistogram: per (className::methodName) self/total instruction
 *     counts and call counts (split between pass 1 and pass 2).
 *   - inlineEdgeHistogram: per "caller -> callee" call counts to identify
 *     hot chains.
 *   - instructionKindHistogram: Int32Array over TACInstructionKind so the
 *     codegen-side per-kind counter at convertInstruction has minimal
 *     overhead at 28.6M call rate.
 */

import { TACInstruction, TACInstructionKind } from "../tac_instruction.js";
import type { ASTToTACConverter } from "./converter.js";

export const PROF = process.env.UDON_PROFILE === "1";

const KIND_NAMES: TACInstructionKind[] = Object.values(TACInstructionKind);
const KIND_ORDINALS: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < KIND_NAMES.length; i++) {
    map[KIND_NAMES[i]] = i;
  }
  return map;
})();

export const KIND_HISTOGRAM_SIZE = KIND_NAMES.length;

export interface InlineHistogramEntry {
  callsTotal: number;
  callsPass1: number;
  selfInstr: number;
  totalInstr: number;
}

export interface EntryProfile {
  inlineHistogram: Record<string, InlineHistogramEntry>;
  inlineEdgeHistogram: Record<string, number>;
  instructionKindHistogram: Record<string, number>;
  totalInstrCount: number;
}

export function histKey(className: string, methodName: string): string {
  return `${className}::${methodName}`;
}

function histGet(c: ASTToTACConverter, key: string): InlineHistogramEntry {
  c.inlineHistogram ??= new Map();
  let e = c.inlineHistogram.get(key);
  if (!e) {
    e = { callsTotal: 0, callsPass1: 0, selfInstr: 0, totalInstr: 0 };
    c.inlineHistogram.set(key, e);
  }
  return e;
}

export function profEnter(c: ASTToTACConverter, key: string): void {
  if (!PROF) return;
  const e = histGet(c, key);
  if (c.metadataOnlyMode) {
    e.callsPass1++;
    e.callsTotal++;
    return;
  }
  e.callsTotal++;
  c.inlineStackKeys ??= [];
  c.inlineStackBefore ??= [];
  c.inlineStackChildTotal ??= [];
  c.inlineEdgeHistogram ??= new Map();
  const parentKey = c.inlineStackKeys[c.inlineStackKeys.length - 1];
  if (parentKey !== undefined) {
    const ek = `${parentKey} -> ${key}`;
    c.inlineEdgeHistogram.set(ek, (c.inlineEdgeHistogram.get(ek) ?? 0) + 1);
  }
  c.inlineStackKeys.push(key);
  c.inlineStackBefore.push(c.instructions.length);
  c.inlineStackChildTotal.push(0);
}

export function profExit(c: ASTToTACConverter): void {
  if (!PROF || c.metadataOnlyMode) return;
  if (!c.inlineStackKeys || !c.inlineStackBefore || !c.inlineStackChildTotal) {
    return;
  }
  const key = c.inlineStackKeys.pop();
  const before = c.inlineStackBefore.pop();
  const childTotal = c.inlineStackChildTotal.pop();
  if (key === undefined || before === undefined || childTotal === undefined) {
    return;
  }
  const totalEmitted = c.instructions.length - before;
  // Clamp to zero: speculative-emission rollbacks (e.g. visitors/call.ts
  // truncating instructions.length after a child's profExit already
  // committed its totalEmitted into childTotal) can leave childTotal
  // larger than the parent's net totalEmitted, producing a spurious
  // negative selfEmitted that would silently corrupt selfInstr.
  const selfEmitted = Math.max(0, totalEmitted - childTotal);
  const depth = c.inlineStackChildTotal.length;
  if (depth > 0) c.inlineStackChildTotal[depth - 1] += totalEmitted;
  const e = histGet(c, key);
  e.selfInstr += selfEmitted;
  e.totalInstr += totalEmitted;
}

export function countKinds(
  c: ASTToTACConverter,
  instructions: TACInstruction[],
): void {
  if (!PROF) return;
  c.instructionKindHistogram ??= new Int32Array(KIND_HISTOGRAM_SIZE);
  for (const instr of instructions) {
    const ord = KIND_ORDINALS[instr.kind];
    if (ord !== undefined) c.instructionKindHistogram[ord]++;
  }
}

interface InlineRow {
  key: string;
  selfInstr: number;
  totalInstr: number;
  callsTotal: number;
  callsPass1: number;
}

export function printHistograms(c: ASTToTACConverter): void {
  if (!PROF) return;
  const hist = c.inlineHistogram;
  const edges = c.inlineEdgeHistogram;
  const kinds = c.instructionKindHistogram;
  const totalInstrCount = c.instructions.length;

  if (hist && hist.size > 0) {
    const rows: InlineRow[] = [];
    for (const [key, e] of hist) {
      rows.push({
        key,
        selfInstr: e.selfInstr,
        totalInstr: e.totalInstr,
        callsTotal: e.callsTotal,
        callsPass1: e.callsPass1,
      });
    }
    rows.sort((a, b) => {
      if (b.selfInstr !== a.selfInstr) return b.selfInstr - a.selfInstr;
      if (b.callsTotal !== a.callsTotal) return b.callsTotal - a.callsTotal;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    console.log(
      "[prof] inline self-cost histogram (top 30 by selfInstr; calls(p2) = callsTotal - callsPass1):",
    );
    let sumSelf = 0;
    for (const row of rows) sumSelf += row.selfInstr;
    const limit = Math.min(30, rows.length);
    for (let i = 0; i < limit; i++) {
      const r = rows[i];
      const callsP2 = r.callsTotal - r.callsPass1;
      console.log(
        `  ${r.key}  selfInstr=${r.selfInstr.toLocaleString()}  totalInstr=${r.totalInstr.toLocaleString()}  calls(p2)=${callsP2}  pass1=${r.callsPass1}`,
      );
    }
    const others = totalInstrCount - sumSelf;
    console.log(
      `[prof] sanity: sum(selfInstr)=${sumSelf.toLocaleString()}  total pass-2 instructions=${totalInstrCount.toLocaleString()}  (others=${others.toLocaleString()})`,
    );
  }

  if (edges && edges.size > 0) {
    const edgeRows = Array.from(edges.entries());
    edgeRows.sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    console.log("[prof] inline edges (top 20 by call count):");
    const limit = Math.min(20, edgeRows.length);
    for (let i = 0; i < limit; i++) {
      console.log(`  ${edgeRows[i][0]}  ${edgeRows[i][1].toLocaleString()}`);
    }
  }

  if (kinds) {
    console.log("[prof] TAC instruction kind histogram (pass 2):");
    for (let i = 0; i < KIND_HISTOGRAM_SIZE; i++) {
      const count = kinds[i];
      if (count > 0) {
        console.log(`  ${KIND_NAMES[i]}: ${count.toLocaleString()}`);
      }
    }
  }
}

export function extractProfileData(c: ASTToTACConverter): EntryProfile {
  const inlineHistogram: Record<string, InlineHistogramEntry> = {};
  if (c.inlineHistogram) {
    for (const [key, e] of c.inlineHistogram) {
      inlineHistogram[key] = {
        callsTotal: e.callsTotal,
        callsPass1: e.callsPass1,
        selfInstr: e.selfInstr,
        totalInstr: e.totalInstr,
      };
    }
  }
  const inlineEdgeHistogram: Record<string, number> = {};
  if (c.inlineEdgeHistogram) {
    for (const [key, count] of c.inlineEdgeHistogram) {
      inlineEdgeHistogram[key] = count;
    }
  }
  const instructionKindHistogram: Record<string, number> = {};
  if (c.instructionKindHistogram) {
    for (let i = 0; i < KIND_HISTOGRAM_SIZE; i++) {
      const count = c.instructionKindHistogram[i];
      if (count > 0) {
        instructionKindHistogram[KIND_NAMES[i]] = count;
      }
    }
  }
  return {
    inlineHistogram,
    inlineEdgeHistogram,
    instructionKindHistogram,
    totalInstrCount: c.instructions.length,
  };
}

export function resetProfiling(c: ASTToTACConverter): void {
  if (!PROF) return;
  c.inlineHistogram = undefined;
  c.inlineStackKeys = undefined;
  c.inlineStackBefore = undefined;
  c.inlineStackChildTotal = undefined;
  c.inlineEdgeHistogram = undefined;
  c.instructionKindHistogram = undefined;
}

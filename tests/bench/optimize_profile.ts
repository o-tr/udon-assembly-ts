/**
 * Per-pass optimizer profiler
 *
 * Uses TACOptimizer's opt-in PassProfileSink to attribute time per pass.
 * Production code path runs through the real optimizer; only the sink is new.
 *
 * Usage:
 *   pnpm tsx tests/bench/optimize_profile.ts
 *   pnpm tsx tests/bench/optimize_profile.ts --scale 5 --runs 3
 *   pnpm tsx tests/bench/optimize_profile.ts --source path/to/Foo.ts
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildExternRegistryFromFiles } from "../../src/transpiler/codegen/extern_registry.js";
import { computeExposedLabels } from "../../src/transpiler/exposed_labels.js";
import { ClassRegistry } from "../../src/transpiler/frontend/class_registry.js";
import { MethodUsageAnalyzer } from "../../src/transpiler/frontend/method_usage_analyzer.js";
import { TypeScriptParser } from "../../src/transpiler/frontend/parser/index.js";
import { TypeMapper } from "../../src/transpiler/frontend/type_mapper.js";
import {
  ASTNodeKind,
  type ClassDeclarationNode,
} from "../../src/transpiler/frontend/types.js";
import { ASTToTACConverter } from "../../src/transpiler/ir/ast_to_tac/index.js";
import { TACOptimizer } from "../../src/transpiler/ir/optimizer/index.js";
import { pruneProgramByMethodUsage } from "../../src/transpiler/ir/optimizer/ipa.js";
import type { PassProfileSink } from "../../src/transpiler/ir/optimizer/tac_optimizer.js";
import type { TACInstruction } from "../../src/transpiler/ir/tac_instruction.js";
import { buildUdonBehaviourLayouts } from "../../src/transpiler/ir/udon_behaviour_layout.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const BASE_SOURCE = `
@UdonBehaviour()
class BigMain extends UdonSharpBehaviour {
  private acc: number = 0;

  Start(): void {
    let s: number = 0;
    for (let i: number = 0; i < 8; i++) {
      s = s + i;
    }
    this.acc = s;
  }
}
`;

/** Build a fixture whose size grows linearly with scale. */
function buildSource(scale: number): string {
  const body = (i: number) => `
class Calculator${i} {
  private a: number = 0;
  private b: number = 0;

  compute(x: number, y: number): number {
    let sum: number = 0;
    for (let k: number = 0; k < 10; k++) {
      let t: number = x * k + y;
      if (t > 0) { sum = sum + t; } else { sum = sum - t; }
      if (k > 5) {
        sum = sum * 2;
        if (sum > 100) { sum = sum - 100; }
      }
    }
    return sum;
  }

  branchy(flag: boolean, input: number): number {
    let r: number = 0;
    if (flag) {
      r = input * 2;
      if (r > 100) { r = r - 50; } else { r = r + 25; }
    } else {
      r = input + 1;
      if (r < 0) { r = -r; }
    }
    return r;
  }
}
`;
  if (scale <= 0) return BASE_SOURCE;
  const classes: string[] = [];
  const fields: string[] = [];
  const calls: string[] = [];
  for (let i = 1; i <= scale; i++) {
    classes.push(body(i));
    fields.push(`  private c${i}: Calculator${i} = new Calculator${i}();`);
    calls.push(`    s = s + this.c${i}.compute(i, i * 2);`);
    calls.push(`    s = s + this.c${i}.branchy(s > 10, s);`);
  }
  return `${classes.join("\n")}

@UdonBehaviour()
class BigMain extends UdonSharpBehaviour {
${fields.join("\n")}
  private acc: number = 0;

  Start(): void {
    let s: number = 0;
    for (let i: number = 0; i < 8; i++) {
${calls.join("\n")}
    }
    this.acc = s;
  }
}
`;
}

// ---------------------------------------------------------------------------
// Build TAC for a source
// ---------------------------------------------------------------------------

function buildTAC(source: string): {
  tac: TACInstruction[];
  exposedLabels: Set<string>;
  parseMs: number;
  astToTacMs: number;
} {
  buildExternRegistryFromFiles([]);

  let t0 = performance.now();
  const parser = new TypeScriptParser();
  const ast = parser.parse(source);
  const parseMs = performance.now() - t0;

  const registry = new ClassRegistry();
  registry.registerFromProgram(ast, "<bench>");
  const symbolTable = parser.getSymbolTable();
  const usage = new MethodUsageAnalyzer(registry).analyze();
  const program = pruneProgramByMethodUsage(ast, usage);

  const entryClassName =
    registry.getEntryPoints()[0]?.name ??
    registry.getAllClasses()[0]?.name ??
    null;
  if (!entryClassName) throw new Error("no entry class");

  const udonBehaviourClasses = new Set(
    program.statements
      .filter(
        (node): node is ClassDeclarationNode =>
          node.kind === ASTNodeKind.ClassDeclaration,
      )
      .filter((cls) => cls.decorators.some((d) => d.name === "UdonBehaviour"))
      .map((cls) => cls.name),
  );
  const typeMapper = new TypeMapper(parser.getEnumRegistry());
  const udonBehaviourInterfaces = registry.getUdonBehaviourInterfaces();
  const interfaceLikes = Array.from(udonBehaviourInterfaces.values()).map(
    (iface) => ({
      name: iface.name,
      methods: iface.methods.map((m) => ({
        name: m.name,
        parameters: m.parameters.map((p) => ({
          name: p.name,
          type: typeMapper.mapTypeScriptType(p.type),
        })),
        returnType: typeMapper.mapTypeScriptType(m.returnType),
      })),
    }),
  );
  const classImplements = registry.getClassImplementsMap();
  const udonBehaviourLayouts = buildUdonBehaviourLayouts(
    program.statements
      .filter(
        (node): node is ClassDeclarationNode =>
          node.kind === ASTNodeKind.ClassDeclaration,
      )
      .map((cls) => ({
        name: cls.name,
        isUdonBehaviour: cls.decorators.some((d) => d.name === "UdonBehaviour"),
        methods: cls.methods.map((method) => ({
          name: method.name,
          parameters: method.parameters.map((param) => ({
            name: param.name,
            type: param.type,
          })),
          returnType: method.returnType,
          isPublic: method.isPublic,
        })),
      })),
    interfaceLikes,
    classImplements,
  );

  t0 = performance.now();
  const tacConverter = new ASTToTACConverter(
    symbolTable,
    parser.getEnumRegistry(),
    udonBehaviourClasses,
    udonBehaviourLayouts,
    registry,
    { useStringBuilder: true, typeMapper: parser.typeMapper },
  );
  const tac = tacConverter.convert(program);
  const astToTacMs = performance.now() - t0;

  const exposedLabels = computeExposedLabels(
    registry,
    udonBehaviourLayouts,
    entryClassName,
  );
  return { tac, exposedLabels, parseMs, astToTacMs };
}

// ---------------------------------------------------------------------------
// Profile sink
// ---------------------------------------------------------------------------

class MapSink implements PassProfileSink {
  totals = new Map<string, number>();
  counts = new Map<string, number>();
  record(name: string, ms: number): void {
    this.totals.set(name, (this.totals.get(name) ?? 0) + ms);
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  source?: string;
  runs: number;
  top: number;
  scale: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { runs: 5, top: 30, scale: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") a.source = argv[++i];
    else if (arg === "--runs") a.runs = Number(argv[++i]);
    else if (arg === "--top") a.top = Number(argv[++i]);
    else if (arg === "--scale") a.scale = Number(argv[++i]);
  }
  return a;
}

function median(vs: number[]): number {
  const s = [...vs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source
    ? fs.readFileSync(path.resolve(args.source), "utf8")
    : buildSource(args.scale);
  console.log(
    `Source: ${args.source ?? `<synthetic scale=${args.scale}>`}  (${source.length} bytes)`,
  );

  // Cold single build for reporting parse/AST→TAC numbers and initial size.
  const initial = buildTAC(source);
  console.log(
    `Parse ${initial.parseMs.toFixed(2)} ms, AST→TAC ${initial.astToTacMs.toFixed(2)} ms, initial TAC size: ${initial.tac.length}`,
  );

  // Warmup (run once and discard, to prime V8 JIT).
  {
    const fresh = buildTAC(source);
    new TACOptimizer().optimize(fresh.tac, fresh.exposedLabels);
  }

  const perRunTotals = new Map<string, number[]>();
  const perRunCounts = new Map<string, number[]>();
  const optimizeTotals: number[] = [];
  let lastFinalSize = -1;

  for (let i = 0; i < args.runs; i++) {
    const fresh = buildTAC(source);
    const sink = new MapSink();
    const t0 = performance.now();
    const out = new TACOptimizer().optimize(fresh.tac, fresh.exposedLabels, {
      profile: sink,
    });
    optimizeTotals.push(performance.now() - t0);
    lastFinalSize = out.length;
    for (const [k, v] of sink.totals) {
      const arr = perRunTotals.get(k) ?? [];
      arr.push(v);
      perRunTotals.set(k, arr);
    }
    for (const [k, v] of sink.counts) {
      const arr = perRunCounts.get(k) ?? [];
      arr.push(v);
      perRunCounts.set(k, arr);
    }
  }

  const grandTotal = median(optimizeTotals);
  const rows: Array<{
    pass: string;
    median_ms: number;
    pct: number;
    calls_per_run: number;
  }> = [];
  for (const [name, totals] of perRunTotals.entries()) {
    const counts = perRunCounts.get(name) ?? [1];
    rows.push({
      pass: name,
      median_ms: median(totals),
      pct: (median(totals) / grandTotal) * 100,
      calls_per_run: median(counts),
    });
  }
  rows.sort((a, b) => b.median_ms - a.median_ms);

  console.log(
    `\n=== Per-pass timing  (runs=${args.runs}, total median=${grandTotal.toFixed(2)} ms, final TAC=${lastFinalSize}) ===`,
  );
  console.table(
    rows.slice(0, args.top).map((r) => ({
      pass: r.pass,
      median_ms: r.median_ms.toFixed(3),
      pct: `${r.pct.toFixed(1)}%`,
      calls_per_run: r.calls_per_run,
    })),
  );

  // Sanity: sum of per-pass medians vs total median
  const summed = rows.reduce((a, b) => a + b.median_ms, 0);
  const accounted = (summed / grandTotal) * 100;
  console.log(
    `Accounted: ${summed.toFixed(2)} ms of ${grandTotal.toFixed(2)} ms (${accounted.toFixed(1)}%)`,
  );
}

main();

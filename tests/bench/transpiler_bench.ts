/**
 * Transpiler performance benchmark
 *
 * Three representative scenarios (per optimize-performance plan Step 0):
 *   A) Hot path: small file, full top-level transpile (TypeScriptToUdonTranspiler)
 *   B) Optimizer: medium file, optimize=true
 *   C) Batch: BatchTranspiler over multiple entry points
 *
 * Also retains a phase-level breakdown (Parse / Registry / AST→TAC / ExposedLabels
 * / Optimize / Codegen / Assemble) so individual phases can be attributed.
 *
 * Usage:
 *   pnpm bench                       # run all scenarios, print table
 *   pnpm bench --json out.json       # also write raw results as JSON
 *   pnpm bench --baseline            # write tests/bench/baseline.json
 *   pnpm bench --compare             # diff current run vs tests/bench/baseline.json
 *   pnpm bench --runs 10             # override run count (default 7)
 *   pnpm bench --only hot,batch      # run a subset of scenarios
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { BatchTranspiler } from "../../src/transpiler/batch/batch_transpiler.js";
import { buildExternRegistryFromFiles } from "../../src/transpiler/codegen/extern_registry.js";
import { TACToUdonConverter } from "../../src/transpiler/codegen/tac_to_udon/index.js";
import { UdonAssembler } from "../../src/transpiler/codegen/udon_assembler.js";
import { computeExposedLabels } from "../../src/transpiler/exposed_labels.js";
import { CallAnalyzer } from "../../src/transpiler/frontend/call_analyzer.js";
import { ClassRegistry } from "../../src/transpiler/frontend/class_registry.js";
import { TypeScriptParser } from "../../src/transpiler/frontend/parser/index.js";
import {
  ASTNodeKind,
  type ClassDeclarationNode,
} from "../../src/transpiler/frontend/types.js";
import { TypeScriptToUdonTranspiler } from "../../src/transpiler/index.js";
import { ASTToTACConverter } from "../../src/transpiler/ir/ast_to_tac/index.js";
import { TACOptimizer } from "../../src/transpiler/ir/optimizer/index.js";
import { buildUdonBehaviourLayouts } from "../../src/transpiler/ir/udon_behaviour_layout.js";

// ---------------------------------------------------------------------------
// Sample sources
// ---------------------------------------------------------------------------

const SMALL_SOURCE = `
class Service {
  private count: number = 0;
  private label: string = "default";
  private active: boolean = true;
  private score: number = 0;
  private factor: number = 1.5;

  getValue(): number {
    return this.count * this.factor;
  }

  increment(): void {
    this.count = this.count + 1;
    this.score = this.score + this.factor;
  }

  reset(): void {
    this.count = 0;
    this.score = 0;
    this.active = false;
  }
}

@UdonBehaviour()
class Main extends UdonSharpBehaviour {
  private service: Service = new Service();
  private result: number = 0;

  Start(): void {
    this.service.increment();
    this.service.increment();
    this.result = this.service.getValue();
  }
}
`;

const MEDIUM_SOURCE = `
interface IScorer {
  score(): number;
}

class ScorerA implements IScorer {
  private base: number = 10;
  private multiplier: number = 2;

  score(): number {
    return this.base * this.multiplier;
  }
}

class ScorerB implements IScorer {
  private value: number = 25;

  score(): number {
    return this.value;
  }
}

class ScorerC implements IScorer {
  private x: number = 5;
  private y: number = 3;

  score(): number {
    return this.x + this.y;
  }
}

class Aggregator {
  private total: number = 0;
  private count: number = 0;

  add(value: number): void {
    this.total = this.total + value;
    this.count = this.count + 1;
  }

  average(): number {
    if (this.count === 0) {
      return 0;
    }
    return this.total / this.count;
  }

  reset(): void {
    this.total = 0;
    this.count = 0;
  }
}

class Formatter {
  private prefix: string = "[Result]";

  format(value: number): string {
    return this.prefix;
  }
}

@UdonBehaviour()
class GameManager extends UdonSharpBehaviour {
  private scorers: IScorer[] = [new ScorerA(), new ScorerB(), new ScorerC()];
  private aggregator: Aggregator = new Aggregator();
  private formatter: Formatter = new Formatter();
  private output: string = "";
  private bestScore: number = 0;

  Start(): void {
    for (const scorer of this.scorers) {
      let s: number = scorer.score();
      this.aggregator.add(s);
      if (s > this.bestScore) {
        this.bestScore = s;
      }
    }
    let avg: number = this.aggregator.average();
    this.output = this.formatter.format(avg);
  }

  Update(): void {
    this.aggregator.reset();
    for (const scorer of this.scorers) {
      this.aggregator.add(scorer.score());
    }
  }
}
`;

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

interface Stats {
  runs: number;
  min: number;
  median: number;
  mean: number;
  p95: number;
  max: number;
}

function summarize(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const median =
    n % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const p95Index = Math.min(n - 1, Math.ceil(0.95 * n) - 1);
  return {
    runs: n,
    min: sorted[0],
    median,
    mean,
    p95: sorted[p95Index],
    max: sorted[n - 1],
  };
}

function fmt(n: number): string {
  return `${n.toFixed(2)} ms`;
}

// ---------------------------------------------------------------------------
// Scenario runners
// ---------------------------------------------------------------------------

interface PhaseTimings {
  parse: number;
  registry: number;
  astToTac: number;
  exposedLabels: number;
  optimize: number;
  codegen: number;
  assemble: number;
  total: number;
}

function runPhaseBreakdown(source: string, optimize: boolean): PhaseTimings {
  const timings: PhaseTimings = {
    parse: 0,
    registry: 0,
    astToTac: 0,
    exposedLabels: 0,
    optimize: 0,
    codegen: 0,
    assemble: 0,
    total: 0,
  };

  const totalStart = performance.now();

  let t0 = performance.now();
  const parser = new TypeScriptParser();
  const ast = parser.parse(source);
  timings.parse = performance.now() - t0;

  t0 = performance.now();
  const registry = new ClassRegistry();
  registry.registerFromProgram(ast, "<bench>");
  timings.registry = performance.now() - t0;

  const symbolTable = parser.getSymbolTable();
  const entryClassName =
    registry.getEntryPoints()[0]?.name ??
    registry.getAllClasses()[0]?.name ??
    null;
  const udonBehaviourClasses = new Set(
    ast.statements
      .filter(
        (node): node is ClassDeclarationNode =>
          node.kind === ASTNodeKind.ClassDeclaration,
      )
      .filter((cls) => cls.decorators.some((d) => d.name === "UdonBehaviour"))
      .map((cls) => cls.name),
  );
  const udonBehaviourInterfaces = registry.getUdonBehaviourInterfaces();
  const interfaceLikes = Array.from(udonBehaviourInterfaces.values()).map(
    (iface) => ({
      name: iface.name,
      methods: iface.methods.map((m) => ({
        name: m.name,
        parameters: m.parameters.map((p) => ({
          name: p.name,
          type: p.type,
        })),
        returnType: m.returnType,
      })),
    }),
  );
  const classImplements = registry.getClassImplementsMap();
  const udonBehaviourLayouts = buildUdonBehaviourLayouts(
    ast.statements
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
  let tacInstructions = tacConverter.convert(ast);
  timings.astToTac = performance.now() - t0;

  t0 = performance.now();
  const exposedLabels = entryClassName
    ? computeExposedLabels(registry, udonBehaviourLayouts, entryClassName)
    : undefined;
  timings.exposedLabels = performance.now() - t0;

  t0 = performance.now();
  if (optimize && exposedLabels) {
    const optimizer = new TACOptimizer();
    tacInstructions = optimizer.optimize(tacInstructions, exposedLabels);
  }
  timings.optimize = performance.now() - t0;

  t0 = performance.now();
  const udonConverter = new TACToUdonConverter();
  let inlineClassNames: ReadonlySet<string> = new Set<string>();
  if (entryClassName) {
    const callAnalyzer = new CallAnalyzer(registry);
    inlineClassNames = callAnalyzer.analyzeClass(entryClassName).inlineClasses;
  }
  const udonInstructions = udonConverter.convert(tacInstructions, {
    entryClassName: entryClassName ?? undefined,
    inlineClassNames,
  });
  const externSignatures = udonConverter.getExternSignatures();
  const dataSectionWithTypes = udonConverter.getDataSectionWithTypes();
  timings.codegen = performance.now() - t0;

  t0 = performance.now();
  const assembler = new UdonAssembler();
  assembler.assemble(
    udonInstructions,
    externSignatures,
    dataSectionWithTypes,
    undefined,
    undefined,
    exposedLabels,
  );
  timings.assemble = performance.now() - t0;

  timings.total = performance.now() - totalStart;
  return timings;
}

// Scenario A/B: top-level API single transpile.
function runTopLevel(source: string, optimize: boolean): number {
  const transpiler = new TypeScriptToUdonTranspiler();
  const t0 = performance.now();
  transpiler.transpile(source, { optimize, silent: true });
  return performance.now() - t0;
}

// Scenario C: batch transpile over a prepared temp directory.
// The directory is created once per scenario (outside the timed region);
// each timed iteration invokes BatchTranspiler.transpile() against it.
// Cache is disabled between runs by wiping .transpiler-cache.json so we
// measure the cold-batch path, which is what CI hits.
function prepareBatchFixture(): { sourceDir: string; outputDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uasm-bench-batch-"));
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  fs.mkdirSync(sourceDir, { recursive: true });

  // Two entry points so per-entry work (layout build, codegen) is exercised
  // more than once — that is where batch-level redundancy surfaces.
  fs.writeFileSync(
    path.join(sourceDir, "EntryA.ts"),
    SMALL_SOURCE.replace("class Main", "class EntryA"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(sourceDir, "EntryB.ts"),
    MEDIUM_SOURCE.replace("class GameManager", "class EntryB"),
    "utf8",
  );
  return { sourceDir, outputDir };
}

function runBatch(fixture: { sourceDir: string; outputDir: string }): number {
  // Wipe cache + outputs so every iteration is a cold batch.
  const cachePath = path.join(fixture.sourceDir, ".transpiler-cache.json");
  if (fs.existsSync(cachePath)) fs.rmSync(cachePath);
  if (fs.existsSync(fixture.outputDir)) {
    fs.rmSync(fixture.outputDir, { recursive: true, force: true });
  }
  const transpiler = new BatchTranspiler();
  const t0 = performance.now();
  transpiler.transpile({
    sourceDir: fixture.sourceDir,
    outputDir: fixture.outputDir,
    excludeDirs: [],
  });
  return performance.now() - t0;
}

// ---------------------------------------------------------------------------
// Scenario registry
// ---------------------------------------------------------------------------

interface ScenarioResult {
  label: string;
  id: string;
  stats: Stats;
  // Phase-level breakdown (median of each phase) when available.
  phases?: Record<keyof PhaseTimings, number>;
}

function runScenario(
  id: string,
  label: string,
  runs: number,
  iter: () => number,
  captureBreakdown?: () => PhaseTimings,
): ScenarioResult {
  // Warmup: 2 iterations, discarded.
  iter();
  iter();

  const totals: number[] = [];
  for (let i = 0; i < runs; i++) {
    totals.push(iter());
  }

  const result: ScenarioResult = {
    id,
    label,
    stats: summarize(totals),
  };

  if (captureBreakdown) {
    const phaseRuns: PhaseTimings[] = [];
    captureBreakdown(); // warmup
    for (let i = 0; i < runs; i++) {
      phaseRuns.push(captureBreakdown());
    }
    const phases: (keyof PhaseTimings)[] = [
      "parse",
      "registry",
      "astToTac",
      "exposedLabels",
      "optimize",
      "codegen",
      "assemble",
      "total",
    ];
    const medianByPhase: Partial<Record<keyof PhaseTimings, number>> = {};
    for (const phase of phases) {
      medianByPhase[phase] = summarize(phaseRuns.map((r) => r[phase])).median;
    }
    result.phases = medianByPhase as Record<keyof PhaseTimings, number>;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printScenario(result: ScenarioResult): void {
  console.log(`\n=== ${result.label} (${result.id}) ===`);
  const { stats } = result;
  console.table({
    min: fmt(stats.min),
    median: fmt(stats.median),
    mean: fmt(stats.mean),
    p95: fmt(stats.p95),
    max: fmt(stats.max),
    runs: String(stats.runs),
  });
  if (result.phases) {
    const rows: Record<string, string> = {};
    for (const [k, v] of Object.entries(result.phases)) {
      rows[k] = fmt(v);
    }
    console.log("  phase-level medians:");
    console.table(rows);
  }
}

function percentDelta(current: number, baseline: number): string {
  if (baseline === 0) return "n/a";
  const pct = ((current - baseline) / baseline) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function printComparison(
  current: ScenarioResult[],
  baseline: ScenarioResult[],
): void {
  console.log("\n=== Comparison vs baseline ===");
  const byId = new Map(baseline.map((b) => [b.id, b]));
  const rows: Record<string, Record<string, string>> = {};
  for (const cur of current) {
    const base = byId.get(cur.id);
    if (!base) {
      rows[cur.id] = {
        median: fmt(cur.stats.median),
        baseline: "(missing)",
        delta: "n/a",
      };
      continue;
    }
    rows[cur.id] = {
      median: fmt(cur.stats.median),
      baseline: fmt(base.stats.median),
      delta: percentDelta(cur.stats.median, base.stats.median),
    };
  }
  console.table(rows);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  runs: number;
  json?: string;
  baseline: boolean;
  compare: boolean;
  only?: Set<string>;
}

/** Reject values that look like a flag (start with "--"), to catch mistakes
 * like `--json --runs 5` where the user forgot the path argument. */
function requireNonFlagValue(flag: string, raw: string | undefined): string {
  if (raw === undefined || raw === "" || raw.startsWith("--")) {
    console.error(`${flag} requires a value (got "${raw ?? "<missing>"}")`);
    process.exit(2);
  }
  return raw;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { runs: 7, baseline: false, compare: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") {
      const raw = requireNonFlagValue("--runs", argv[++i]);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`--runs requires a positive integer (got "${raw}")`);
        process.exit(2);
      }
      args.runs = n;
    } else if (a === "--json") {
      args.json = requireNonFlagValue("--json", argv[++i]);
    } else if (a === "--baseline") {
      args.baseline = true;
    } else if (a === "--compare") {
      args.compare = true;
    } else if (a === "--only") {
      const raw = requireNonFlagValue("--only", argv[++i]);
      // IDs validated against the scenario list in main(), which is the
      // single source of truth — keep raw form here.
      args.only = new Set(raw.split(","));
    } else {
      console.warn(`Unknown bench arg: ${a}`);
    }
  }
  return args;
}

const BASELINE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "baseline.json",
);

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  buildExternRegistryFromFiles([]);

  const fixture = prepareBatchFixture();
  try {
    const scenarios: Array<{
      id: string;
      label: string;
      run: () => number;
      breakdown?: () => PhaseTimings;
    }> = [
      {
        id: "hot",
        label: "Small file, top-level transpile (no optimize)",
        run: () => runTopLevel(SMALL_SOURCE, false),
        breakdown: () => runPhaseBreakdown(SMALL_SOURCE, false),
      },
      {
        id: "optimize",
        label: "Medium file, top-level transpile (optimize=true)",
        run: () => runTopLevel(MEDIUM_SOURCE, true),
        breakdown: () => runPhaseBreakdown(MEDIUM_SOURCE, true),
      },
      {
        id: "batch",
        label: "BatchTranspiler, 2 entry points (cold cache)",
        run: () => runBatch(fixture),
      },
    ];

    // Validate `--only` IDs against the actual scenario list — the single
    // source of truth — so adding a new scenario doesn't require updating a
    // separate constant.
    if (args.only) {
      const knownIds = new Set(scenarios.map((s) => s.id));
      const unknown = [...args.only].filter((id) => !knownIds.has(id));
      if (unknown.length > 0) {
        console.error(
          `--only: unknown scenario id(s): ${unknown.join(", ")}. Known: ${[...knownIds].join(", ")}`,
        );
        process.exit(2);
      }
    }

    const results: ScenarioResult[] = [];
    for (const s of scenarios) {
      if (args.only && !args.only.has(s.id)) continue;
      const r = runScenario(s.id, s.label, args.runs, s.run, s.breakdown);
      printScenario(r);
      results.push(r);
    }

    // Baseline compare
    if (args.compare) {
      if (!fs.existsSync(BASELINE_PATH)) {
        console.error(
          `\nNo baseline file at ${BASELINE_PATH}. Run with --baseline first.`,
        );
        process.exitCode = 1;
      } else {
        const baseline = JSON.parse(
          fs.readFileSync(BASELINE_PATH, "utf8"),
        ) as ScenarioResult[];
        printComparison(results, baseline);
      }
    }

    // Refuse to write empty result sets to either baseline or --json so an
    // invalid `--only` filter never overwrites a good baseline with nothing.
    if ((args.baseline || args.json) && results.length === 0) {
      console.error(
        "No scenarios ran (check --only filter); refusing to write empty results.",
      );
      process.exitCode = 1;
    } else {
      if (args.baseline) {
        fs.writeFileSync(
          BASELINE_PATH,
          `${JSON.stringify(results, null, 2)}\n`,
        );
        console.log(`\nWrote baseline to ${BASELINE_PATH}`);
      }
      if (args.json) {
        fs.writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
        console.log(`\nWrote results to ${args.json}`);
      }
    }
  } finally {
    // Always clean up the batch fixture root, even if a scenario threw.
    try {
      fs.rmSync(path.dirname(fixture.sourceDir), {
        recursive: true,
        force: true,
      });
    } catch {
      // ignore
    }
  }
}

main();

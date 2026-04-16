/**
 * Transpiler performance benchmark
 *
 * Measures each pipeline phase independently:
 *   Parse → ClassRegistry → AST→TAC → Optimize → Codegen → Assemble
 *
 * Usage: pnpm bench
 */

import { performance } from "node:perf_hooks";
import { buildExternRegistryFromFiles } from "../../src/transpiler/codegen/extern_registry.js";
import { TACToUdonConverter } from "../../src/transpiler/codegen/tac_to_udon/index.js";
import { UdonAssembler } from "../../src/transpiler/codegen/udon_assembler.js";
import { computeExposedLabels } from "../../src/transpiler/exposed_labels.js";
import { CallAnalyzer } from "../../src/transpiler/frontend/call_analyzer.js";
import { ClassRegistry } from "../../src/transpiler/frontend/class_registry.js";
import { TypeScriptParser } from "../../src/transpiler/frontend/parser/index.js";
import { TypeMapper } from "../../src/transpiler/frontend/type_mapper.js";
import {
  ASTNodeKind,
  type ClassDeclarationNode,
} from "../../src/transpiler/frontend/types.js";
import { ASTToTACConverter } from "../../src/transpiler/ir/ast_to_tac/index.js";
import { TACOptimizer } from "../../src/transpiler/ir/optimizer/index.js";
import { buildUdonBehaviourLayouts } from "../../src/transpiler/ir/udon_behaviour_layout.js";

// ---------------------------------------------------------------------------
// Test inputs
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
// Benchmark runner
// ---------------------------------------------------------------------------

interface PhaseTimings {
  parse: number;
  registry: number;
  astToTac: number;
  optimize: number;
  codegen: number;
  assemble: number;
  total: number;
}

function runSingleBenchmark(source: string, optimize: boolean): PhaseTimings {
  const timings: PhaseTimings = {
    parse: 0,
    registry: 0,
    astToTac: 0,
    optimize: 0,
    codegen: 0,
    assemble: 0,
    total: 0,
  };

  const totalStart = performance.now();

  // Phase 1: Parse
  let t0 = performance.now();
  const parser = new TypeScriptParser();
  const ast = parser.parse(source);
  timings.parse = performance.now() - t0;

  // Phase 2: ClassRegistry
  t0 = performance.now();
  const registry = new ClassRegistry();
  registry.registerFromProgram(ast, "<bench>");
  timings.registry = performance.now() - t0;

  // Setup for TAC conversion
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

  // Phase 3: AST → TAC
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

  // Phase 4: Optimize (optional)
  t0 = performance.now();
  let exposedLabels: ReturnType<typeof computeExposedLabels> | undefined;
  if (optimize && entryClassName) {
    const optimizer = new TACOptimizer();
    exposedLabels = computeExposedLabels(
      registry,
      udonBehaviourLayouts,
      entryClassName,
    );
    tacInstructions = optimizer.optimize(tacInstructions, exposedLabels);
  }
  timings.optimize = performance.now() - t0;

  // Phase 5: Codegen (TAC → Udon)
  t0 = performance.now();
  const udonConverter = new TACToUdonConverter();
  const callAnalyzer = entryClassName ? new CallAnalyzer(registry) : null;
  const inlineClassNames = entryClassName
    ? callAnalyzer?.analyzeClass(entryClassName).inlineClasses
    : new Set<string>();
  const udonInstructions = udonConverter.convert(tacInstructions, {
    entryClassName: entryClassName ?? undefined,
    inlineClassNames,
  });
  const externSignatures = udonConverter.getExternSignatures();
  const dataSectionWithTypes = udonConverter.getDataSectionWithTypes();
  timings.codegen = performance.now() - t0;

  // Phase 6: Assemble
  t0 = performance.now();
  if (!exposedLabels && entryClassName) {
    exposedLabels = computeExposedLabels(
      registry,
      udonBehaviourLayouts,
      entryClassName,
    );
  }
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function runBenchmarkSuite(
  label: string,
  source: string,
  optimize: boolean,
  runs: number = 5,
): void {
  const allTimings: PhaseTimings[] = [];
  // Warmup (1 run, discarded)
  runSingleBenchmark(source, optimize);

  for (let i = 0; i < runs; i++) {
    allTimings.push(runSingleBenchmark(source, optimize));
  }

  const phases: (keyof PhaseTimings)[] = [
    "parse",
    "registry",
    "astToTac",
    "optimize",
    "codegen",
    "assemble",
    "total",
  ];
  const result: Record<string, string> = {};
  for (const phase of phases) {
    const values = allTimings.map((t) => t[phase]);
    const med = median(values);
    result[phase] = `${med.toFixed(2)} ms`;
  }

  console.log(`\n=== ${label} ===`);
  console.table(result);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

buildExternRegistryFromFiles([]);

runBenchmarkSuite("Small (no optimize)", SMALL_SOURCE, false);
runBenchmarkSuite("Small (optimize)", SMALL_SOURCE, true);
runBenchmarkSuite("Medium (no optimize)", MEDIUM_SOURCE, false);
runBenchmarkSuite("Medium (optimize)", MEDIUM_SOURCE, true);

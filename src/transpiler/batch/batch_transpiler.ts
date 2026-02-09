/**
 * Batch transpiler orchestrator
 */

import fs from "node:fs";
import path from "node:path";
import { buildExternRegistryFromFiles } from "../codegen/extern_registry.js";
import { TACToUdonConverter } from "../codegen/tac_to_udon/index.js";
import { computeTypeId } from "../codegen/type_metadata_registry.js";
import { UdonAssembler } from "../codegen/udon_assembler.js";
import { ErrorCollector } from "../errors/error_collector.js";
import {
  AggregateTranspileError,
  DuplicateTopLevelConstError,
} from "../errors/transpile_errors.js";
import {
  computeExportLabels,
  computeExposedLabels,
} from "../exposed_labels.js";
import { CallAnalyzer } from "../frontend/call_analyzer.js";
import type {
  MethodInfo,
  PropertyInfo,
  TopLevelConstInfo,
} from "../frontend/class_registry.js";
import { ClassRegistry } from "../frontend/class_registry.js";
import { InheritanceValidator } from "../frontend/inheritance_validator.js";
import { MethodUsageAnalyzer } from "../frontend/method_usage_analyzer.js";
import { TypeScriptParser } from "../frontend/parser/index.js";
import { SymbolTable } from "../frontend/symbol_table.js";
import { TypeMapper } from "../frontend/type_mapper.js";
import {
  type ASTNode,
  ASTNodeKind,
  type ClassDeclarationNode,
  type DecoratorNode,
  type ProgramNode,
  type VariableDeclarationNode,
} from "../frontend/types.js";
import {
  buildHeapUsageTreeBreakdown,
  computeHeapUsage,
  TASM_HEAP_LIMIT,
  UASM_HEAP_LIMIT,
} from "../heap_limits.js";
import { ASTToTACConverter } from "../ir/ast_to_tac/index.js";
import { TACOptimizer } from "../ir/optimizer/index.js";
import { buildUdonBehaviourLayouts } from "../ir/udon_behaviour_layout.js";
import { DependencyResolver } from "./dependency_resolver.js";
import {
  discoverEntryFilesUsingTS,
  discoverTypeScriptFiles,
} from "./file_discovery.js";

function isTranspilableSource(filePath: string): boolean {
  if (filePath.endsWith(".d.ts")) return false;
  return filePath.endsWith(".ts") || filePath.endsWith(".tsx");
}

export interface BatchTranspilerOptions {
  sourceDir: string;
  outputDir: string;
  optimize?: boolean;
  reflect?: boolean;
  useStringBuilder?: boolean;
  verbose?: boolean;
  excludeDirs?: string[];
  allowCircular?: boolean;
  includeExternalDependencies?: boolean;
  outputExtension?: string;
  heapLimit?: number;
}

export interface BatchFileResult {
  className: string;
  outputPath: string;
}

export interface BatchResult {
  outputs: BatchFileResult[];
}

export class BatchTranspiler {
  transpile(options: BatchTranspilerOptions): BatchResult {
    const errorCollector = new ErrorCollector();
    const parser = new TypeScriptParser(errorCollector);
    const registry = new ClassRegistry();
    const typeMapper = new TypeMapper(parser.getEnumRegistry());
    const cachePath = path.join(options.sourceDir, ".transpiler-cache.json");
    const cache = this.loadCache(cachePath);

    const rawFiles = discoverTypeScriptFiles({
      sourceDir: options.sourceDir,
      excludeDirs: options.excludeDirs,
    });
    const files = rawFiles.map((f) => fs.realpathSync(f));
    const fileSet = new Set(files);

    const entryFiles = discoverEntryFilesUsingTS({
      sourceDir: options.sourceDir,
      excludeDirs: options.excludeDirs,
    })
      .map((f) => fs.realpathSync(f))
      .filter((f) => fileSet.has(f));

    const resolver = new DependencyResolver(options.sourceDir, {
      allowCircular: options.allowCircular,
    });
    const reachable = new Set<string>();
    const fallbackDeps = new Set<string>();
    const includeExternal = options.includeExternalDependencies !== false;
    if (entryFiles.length > 0) {
      for (const entry of entryFiles) {
        try {
          const graph = resolver.buildGraph(entry);
          reachable.add(entry);
          for (const [k, deps] of graph.entries()) {
            reachable.add(k);
            for (const d of deps) reachable.add(d);
          }
        } catch (e) {
          if (options?.verbose) {
            console.warn(
              `Failed to build dependency graph for ${entry}: ${e instanceof Error ? e.message : e}`,
            );
          }
          if (includeExternal) {
            try {
              for (const dep of resolver.resolveImmediateDependencies(entry)) {
                fallbackDeps.add(dep);
              }
            } catch (fallbackError) {
              if (options?.verbose) {
                console.warn(
                  `Failed to resolve immediate dependencies for ${entry}: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`,
                );
              }
            }
          }
        }
      }
    }

    if (includeExternal && fallbackDeps.size > 0) {
      for (const dep of fallbackDeps) reachable.add(dep);
    }

    const cacheFiles =
      entryFiles.length > 0 && reachable.size > 0
        ? Array.from(reachable)
        : files;

    buildExternRegistryFromFiles(cacheFiles);
    const changedFiles = this.getChangedFiles(cacheFiles, cache);
    const entryFilesToCompile = new Set<string>(entryFiles);
    if (cache) {
      entryFilesToCompile.clear();
      for (const entryFile of entryFiles) {
        try {
          resolver.buildGraph(entryFile);
          const compilationOrder = resolver.getCompilationOrder(entryFile);
          const hasChanges = compilationOrder.some((file) =>
            changedFiles.has(file),
          );
          if (hasChanges) {
            entryFilesToCompile.add(entryFile);
          }
        } catch (_) {
          entryFilesToCompile.add(entryFile);
        }
      }
    }

    if (entryFiles.length === 0) {
      // Fallback: register all files
      for (const filePath of files) {
        const source = fs.readFileSync(filePath, "utf8");
        const program = parser.parse(source, filePath);
        registry.registerFromProgram(program, filePath, source);
      }
    } else {
      const reachableFiles = reachable.size > 0 ? Array.from(reachable) : files;
      const allTranspilableFiles = includeExternal
        ? Array.from(new Set([...files, ...reachableFiles]))
        : reachableFiles;
      const transpilableFiles =
        allTranspilableFiles.filter(isTranspilableSource);
      // Register transpilable files so inline class detection is reliable.
      for (const filePath of transpilableFiles) {
        try {
          const source = fs.readFileSync(filePath, "utf8");
          const program = parser.parse(source, filePath);
          registry.registerFromProgram(program, filePath, source);
        } catch (e) {
          // parsing errors will be collected by parser's ErrorCollector
          // but file read or other unexpected errors should be logged for diagnostics
          if (options?.verbose) {
            console.warn(
              `Failed to read/parse ${filePath}: ${e instanceof Error ? e.message : e}`,
            );
          }
        }
      }
    }

    const validator = new InheritanceValidator(registry, errorCollector);
    for (const entryPoint of registry.getEntryPoints()) {
      validator.validate(entryPoint.name);
    }
    const udonBehaviourInterfaceNames = new Set(
      registry.getUdonBehaviourInterfaces().keys(),
    );
    validator.validateUdonBehaviourInterfaceConsistency(
      udonBehaviourInterfaceNames,
    );

    if (errorCollector.hasErrors()) {
      throw new AggregateTranspileError(errorCollector.getErrors());
    }

    const outputs: BatchFileResult[] = [];
    const callAnalyzer = new CallAnalyzer(registry);
    const methodUsage =
      options.optimize === true
        ? new MethodUsageAnalyzer(registry).analyze()
        : null;

    const ext = options.outputExtension ?? "tasm";
    const heapLimit =
      options.heapLimit ?? (ext === "tasm" ? TASM_HEAP_LIMIT : UASM_HEAP_LIMIT);

    for (const entryPoint of registry.getEntryPoints()) {
      if (!entryFilesToCompile.has(entryPoint.filePath)) {
        continue;
      }
      const _entryFile = entryPoint.filePath;

      const mergedMethods = registry.getMergedMethods(entryPoint.name);
      const mergedProperties = registry.getMergedProperties(entryPoint.name);

      const inlineClassNames = Array.from(
        this.collectReachableInlineClasses(
          entryPoint.name,
          callAnalyzer,
          registry,
        ),
      );

      const filteredInlineClassNames = inlineClassNames.filter((name) => {
        const meta = registry.getClass(name);
        if (!meta) return true;
        return !meta.decorators.some(
          (decorator) => decorator.name === "UdonBehaviour",
        );
      });

      const entryPointMethods = this.orderEntryMethods(
        this.filterMethodsByUsage(mergedMethods, entryPoint.name, methodUsage),
      );

      const symbolTable = new SymbolTable();
      for (const prop of mergedProperties) {
        symbolTable.addSymbol(
          prop.name,
          typeMapper.mapTypeScriptType(prop.type),
          false,
          false,
        );
      }

      let topLevelConsts: TopLevelConstInfo[];
      try {
        topLevelConsts = this.collectAllTopLevelConsts(
          entryPoint.filePath,
          filteredInlineClassNames,
          registry,
        );
      } catch (e) {
        if (this.collectDuplicateConstErrors(e, errorCollector)) continue;
        throw e;
      }
      for (const tlc of topLevelConsts) {
        if (!symbolTable.hasInCurrentScope(tlc.name)) {
          symbolTable.addSymbol(
            tlc.name,
            typeMapper.mapTypeScriptType(tlc.type),
            false,
            true,
            tlc.node.initializer,
          );
        }
      }

      const topLevelConstNodes = topLevelConsts.map((tlc) => tlc.node);
      const methodProgram = this.classesToProgram(
        this.buildClassNodes(
          entryPoint.name,
          entryPointMethods,
          filteredInlineClassNames,
          registry,
          methodUsage,
        ),
        topLevelConstNodes,
      );
      const udonBehaviourClasses = new Set(
        registry
          .getAllClasses()
          .filter((cls) =>
            cls.decorators.some(
              (decorator) => decorator.name === "UdonBehaviour",
            ),
          )
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
              type: typeMapper.mapTypeScriptType(p.type),
            })),
            returnType: typeMapper.mapTypeScriptType(m.returnType),
          })),
        }),
      );
      const classImplements = registry.getClassImplementsMap();
      const udonBehaviourLayouts = buildUdonBehaviourLayouts(
        registry.getAllClasses().map((cls) => ({
          name: cls.name,
          isUdonBehaviour: cls.decorators.some(
            (decorator) => decorator.name === "UdonBehaviour",
          ),
          methods: cls.methods.map((method) => ({
            name: method.name,
            parameters: method.parameters.map((param) => ({
              name: param.name,
              type: typeMapper.mapTypeScriptType(param.type),
            })),
            returnType: typeMapper.mapTypeScriptType(method.returnType),
            isPublic: method.isPublic,
          })),
        })),
        interfaceLikes,
        classImplements,
      );
      const tacConverter = new ASTToTACConverter(
        symbolTable,
        parser.getEnumRegistry(),
        udonBehaviourClasses,
        udonBehaviourLayouts,
        registry,
        { useStringBuilder: options.useStringBuilder },
      );
      let tacInstructions = tacConverter.convert(methodProgram);

      if (options.optimize === true) {
        const optimizer = new TACOptimizer();
        const exposedLabels = computeExposedLabels(
          registry,
          udonBehaviourLayouts,
          entryPoint.name,
        );
        tacInstructions = optimizer.optimize(tacInstructions, exposedLabels);
      }

      const udonConverter = new TACToUdonConverter();
      const inlineClassNameSet = new Set(filteredInlineClassNames);
      const udonInstructions = udonConverter.convert(tacInstructions, {
        entryClassName: entryPoint.name,
        inlineClassNames: inlineClassNameSet,
      });
      const externSignatures = udonConverter.getExternSignatures();
      let dataSectionWithTypes = udonConverter.getDataSectionWithTypes();
      if (options.reflect === true) {
        dataSectionWithTypes = this.appendReflectionData(
          dataSectionWithTypes,
          entryPoint.name,
        );
      }
      const syncModes = new Map<string, string>();
      for (const prop of mergedProperties) {
        if (prop.syncMode) {
          syncModes.set(prop.name, prop.syncMode.toLowerCase());
        }
      }

      const exportLabels = computeExportLabels(
        registry,
        udonBehaviourLayouts,
        entryPoint.name,
      );
      const assembler = new UdonAssembler();
      const uasm = assembler.assemble(
        udonInstructions,
        externSignatures,
        dataSectionWithTypes,
        syncModes,
        entryPoint.behaviourSyncMode,
        exportLabels,
      );
      let splitCandidates: Map<string, number> | undefined;
      const heapUsage = computeHeapUsage(dataSectionWithTypes);
      if (heapUsage > heapLimit) {
        try {
          splitCandidates = this.estimateSplitCandidates(
            filteredInlineClassNames,
            registry,
            callAnalyzer,
            parser,
            typeMapper,
            udonBehaviourLayouts,
            udonBehaviourClasses,
            options.optimize,
            options.reflect,
            options.useStringBuilder,
            methodUsage,
          );
        } catch (e) {
          if (this.collectDuplicateConstErrors(e, errorCollector)) continue;
          throw e;
        }
      }

      this.ensureHeapWithinLimit(
        entryPoint.name,
        dataSectionWithTypes,
        udonConverter.getHeapUsageByClass(),
        callAnalyzer,
        registry,
        splitCandidates,
        heapUsage,
        heapLimit,
      );

      const outPath = path.join(options.outputDir, `${entryPoint.name}.${ext}`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, uasm, "utf8");

      outputs.push({ className: entryPoint.name, outputPath: outPath });
    }

    if (errorCollector.hasErrors()) {
      throw new AggregateTranspileError(errorCollector.getErrors());
    }

    this.saveCache(cachePath, cacheFiles);
    return { outputs };
  }

  private ensureHeapWithinLimit(
    entryPointName: string,
    dataSection: Array<[string, number, string, unknown]>,
    usageByClass: Map<string, number>,
    callAnalyzer: CallAnalyzer,
    registry: ClassRegistry,
    splitCandidates?: Map<string, number>,
    heapUsage?: number,
    heapLimit?: number,
  ): void {
    heapLimit = heapLimit ?? UASM_HEAP_LIMIT;
    const resolvedUsage = heapUsage ?? computeHeapUsage(dataSection);
    if (resolvedUsage <= heapLimit) return;

    const breakdown = buildHeapUsageTreeBreakdown(
      usageByClass,
      resolvedUsage,
      entryPointName,
      callAnalyzer,
      registry,
    );
    const messageParts = [
      `UASM heap usage ${resolvedUsage} exceeds limit ${heapLimit} for ${entryPointName}.`,
      "Heap usage by class:",
      breakdown || "  - <no data>",
    ];
    const splitReport = this.formatSplitCandidateReport(splitCandidates);
    if (splitReport) {
      messageParts.push(
        "Split candidates (estimated heap if separated as UdonBehaviour):",
        splitReport,
      );
    }
    const message = messageParts.join("\n");
    console.warn(message);
  }

  private formatSplitCandidateReport(
    candidates?: Map<string, number>,
  ): string | null {
    if (!candidates || candidates.size === 0) return null;
    const entries = Array.from(candidates.entries())
      .filter(([, heapUsage]) => heapUsage > 0)
      .sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return null;

    const top = entries.slice(0, 10);
    return top
      .map(([className, usage]) => `  - ${className}: ${usage}`)
      .join("\n");
  }

  private estimateSplitCandidates(
    inlineClassNames: string[],
    registry: ClassRegistry,
    callAnalyzer: CallAnalyzer,
    parser: TypeScriptParser,
    typeMapper: TypeMapper,
    udonBehaviourLayouts: ReturnType<typeof buildUdonBehaviourLayouts>,
    udonBehaviourClasses: Set<string>,
    optimize?: boolean,
    reflect?: boolean,
    useStringBuilder?: boolean,
    methodUsage?: Map<string, Set<string>> | null,
  ): Map<string, number> {
    const results = new Map<string, number>();
    for (const className of inlineClassNames) {
      try {
        results.set(
          className,
          this.estimateHeapUsageForClass(
            className,
            registry,
            callAnalyzer,
            parser,
            typeMapper,
            udonBehaviourLayouts,
            udonBehaviourClasses,
            optimize,
            reflect,
            useStringBuilder,
            methodUsage ?? null,
          ),
        );
      } catch (e) {
        // Rethrow duplicate-const errors from collectAllTopLevelConsts
        if (e instanceof DuplicateTopLevelConstError) {
          throw e;
        }
        // If estimation fails for other reasons, set to 0 rather than blocking the error message
        results.set(className, 0);
      }
    }
    return results;
  }

  private estimateHeapUsageForClass(
    entryPointName: string,
    registry: ClassRegistry,
    callAnalyzer: CallAnalyzer,
    parser: TypeScriptParser,
    typeMapper: TypeMapper,
    udonBehaviourLayouts: ReturnType<typeof buildUdonBehaviourLayouts>,
    udonBehaviourClasses: Set<string>,
    optimize?: boolean,
    reflect?: boolean,
    useStringBuilder?: boolean,
    methodUsage: Map<string, Set<string>> | null = null,
  ): number {
    const mergedMethods = registry.getMergedMethods(entryPointName);
    const mergedProperties = registry.getMergedProperties(entryPointName);
    const entryPointMethods = this.orderEntryMethods(
      this.filterMethodsByUsage(mergedMethods, entryPointName, methodUsage),
    );

    const reachableInline = Array.from(
      this.collectReachableInlineClasses(
        entryPointName,
        callAnalyzer,
        registry,
      ),
    );
    const filteredInline = reachableInline.filter((name) => {
      const meta = registry.getClass(name);
      if (!meta) return true;
      return !meta.decorators.some(
        (decorator) => decorator.name === "UdonBehaviour",
      );
    });

    const symbolTable = new SymbolTable();
    for (const prop of mergedProperties) {
      symbolTable.addSymbol(
        prop.name,
        typeMapper.mapTypeScriptType(prop.type),
        false,
        false,
      );
    }

    const entryMeta = registry.getClass(entryPointName);
    const estTopLevelConsts = entryMeta
      ? this.collectAllTopLevelConsts(
          entryMeta.filePath,
          filteredInline,
          registry,
        )
      : [];
    for (const tlc of estTopLevelConsts) {
      if (!symbolTable.hasInCurrentScope(tlc.name)) {
        symbolTable.addSymbol(
          tlc.name,
          typeMapper.mapTypeScriptType(tlc.type),
          false,
          true,
          tlc.node.initializer,
        );
      }
    }

    const estTopLevelConstNodes = estTopLevelConsts.map((tlc) => tlc.node);
    const methodProgram = this.classesToProgram(
      this.buildClassNodes(
        entryPointName,
        entryPointMethods,
        filteredInline,
        registry,
        methodUsage,
      ),
      estTopLevelConstNodes,
    );
    const tacConverter = new ASTToTACConverter(
      symbolTable,
      parser.getEnumRegistry(),
      udonBehaviourClasses,
      udonBehaviourLayouts,
      registry,
      { useStringBuilder },
    );
    let tacInstructions = tacConverter.convert(methodProgram);

    if (optimize === true) {
      const optimizer = new TACOptimizer();
      const exposedLabels = computeExposedLabels(
        registry,
        udonBehaviourLayouts,
        entryPointName,
      );
      tacInstructions = optimizer.optimize(tacInstructions, exposedLabels);
    }

    const udonConverter = new TACToUdonConverter();
    const inlineClassNameSet = new Set(filteredInline);
    udonConverter.convert(tacInstructions, {
      entryClassName: entryPointName,
      inlineClassNames: inlineClassNameSet,
    });
    let dataSectionWithTypes = udonConverter.getDataSectionWithTypes();
    if (reflect === true) {
      dataSectionWithTypes = this.appendReflectionData(
        dataSectionWithTypes,
        entryPointName,
      );
    }
    return computeHeapUsage(dataSectionWithTypes);
  }

  private loadCache(cachePath: string): Record<string, number> | null {
    try {
      if (!fs.existsSync(cachePath)) return null;
      const raw = fs.readFileSync(cachePath, "utf8");
      return JSON.parse(raw) as Record<string, number>;
    } catch {
      return null;
    }
  }

  private saveCache(cachePath: string, files: string[]): void {
    const snapshot: Record<string, number> = {};
    for (const file of files) {
      try {
        snapshot[file] = fs.statSync(file).mtimeMs;
      } catch {
        // ignore
      }
    }
    fs.writeFileSync(cachePath, JSON.stringify(snapshot, null, 2), "utf8");
  }

  private getChangedFiles(
    files: string[],
    cache: Record<string, number> | null,
  ): Set<string> {
    const changed = new Set<string>();
    if (!cache) {
      for (const file of files) changed.add(file);
      return changed;
    }
    for (const file of files) {
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (!cache[file] || cache[file] !== mtime) {
          changed.add(file);
        }
      } catch {
        changed.add(file);
      }
    }
    return changed;
  }

  private pickEntryMethod(methods: MethodInfo[]): MethodInfo | null {
    const start = methods.find((method) => method.name === "Start");
    if (start) return start;
    const underscore = methods.find((method) => method.name === "_start");
    if (underscore) return underscore;
    return null;
  }

  private orderEntryMethods(methods: MethodInfo[]): MethodInfo[] {
    const entry = this.pickEntryMethod(methods);
    if (!entry) return methods;
    return [entry, ...methods.filter((method) => method !== entry)];
  }

  private filterMethodsByUsage(
    methods: MethodInfo[],
    className: string,
    usage: Map<string, Set<string>> | null,
  ): MethodInfo[] {
    if (!usage) return methods;
    const reachable = usage.get(className);
    if (!reachable) return [];
    return methods.filter((method) => reachable.has(method.name));
  }

  private collectDuplicateConstErrors(
    e: unknown,
    errorCollector: ErrorCollector,
  ): boolean {
    if (e instanceof DuplicateTopLevelConstError) {
      for (const te of e.toTranspileErrors()) {
        errorCollector.add(te);
      }
      return true;
    }
    return false;
  }

  private collectAllTopLevelConsts(
    entryFilePath: string,
    inlineClassNames: string[],
    registry: ClassRegistry,
  ): TopLevelConstInfo[] {
    const entryConsts = registry.getTopLevelConstsForFile(entryFilePath);
    const constByName = new Map<string, TopLevelConstInfo>();
    for (const tlc of entryConsts) {
      constByName.set(tlc.name, tlc);
    }
    const allConsts = [...entryConsts];

    const inlineFilePaths = new Set<string>();
    for (const inlineName of inlineClassNames) {
      const meta = registry.getClass(inlineName);
      if (meta && meta.filePath !== entryFilePath) {
        inlineFilePaths.add(meta.filePath);
      }
    }

    for (const filePath of Array.from(inlineFilePaths).sort()) {
      for (const tlc of registry.getTopLevelConstsForFile(filePath)) {
        const existing = constByName.get(tlc.name);
        if (existing) {
          throw new DuplicateTopLevelConstError(
            tlc.name,
            {
              filePath: existing.filePath,
              line: existing.line,
              column: existing.column,
            },
            { filePath: tlc.filePath, line: tlc.line, column: tlc.column },
          );
        }
        constByName.set(tlc.name, tlc);
        allConsts.push(tlc);
      }
    }

    return allConsts;
  }

  private collectReachableInlineClasses(
    entryPointName: string,
    callAnalyzer: CallAnalyzer,
    registry: ClassRegistry,
  ): Set<string> {
    const reachable = new Set<string>();
    const visited = new Set<string>();
    const queue: string[] = [entryPointName];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);

      const analysis = callAnalyzer.analyzeClass(current);
      for (const className of analysis.inlineClasses) {
        if (className === entryPointName) continue;
        if (registry.isStub(className)) continue;
        const meta = registry.getClass(className);
        if (!meta) continue;
        if (
          meta.decorators.some(
            (decorator) => decorator.name === "UdonBehaviour",
          )
        ) {
          continue;
        }
        if (!reachable.has(className)) {
          reachable.add(className);
          queue.push(className);
        }
      }
    }

    return reachable;
  }

  private buildClassNodes(
    entryPointName: string,
    entryPointMethods: MethodInfo[],
    inlineClassNames: string[],
    registry: ClassRegistry,
    methodUsage: Map<string, Set<string>> | null,
  ): ClassDeclarationNode[] {
    const nodes: ClassDeclarationNode[] = [];
    const entryMeta = registry.getClass(entryPointName);
    const entryProperties = entryMeta
      ? registry.getMergedProperties(entryPointName)
      : [];

    nodes.push(
      this.buildClassNode(
        entryPointName,
        entryMeta?.baseClass ?? null,
        entryPointMethods,
        entryProperties,
        entryMeta?.constructor,
      ),
    );

    for (const inlineName of inlineClassNames) {
      const inlineMeta = registry.getClass(inlineName);
      if (!inlineMeta) continue;
      nodes.push(
        this.buildClassNode(
          inlineName,
          inlineMeta.baseClass,
          this.filterMethodsByUsage(
            registry.getMergedMethods(inlineName),
            inlineName,
            methodUsage,
          ),
          registry.getMergedProperties(inlineName),
          inlineMeta.constructor,
        ),
      );
    }

    return nodes;
  }

  private appendReflectionData(
    dataSection: Array<[string, number, string, unknown]>,
    className: string,
  ): Array<[string, number, string, unknown]> {
    let maxAddress = dataSection.reduce(
      (max, entry) => Math.max(max, entry[1]),
      -1,
    );
    const nextAddress = () => {
      maxAddress += 1;
      return maxAddress;
    };

    const typeId = computeTypeId(className);
    const hexId = `0x${typeId.toString(16)}`;
    const entries: Array<[string, number, string, unknown]> = [
      ["__refl_typeid", nextAddress(), "Int64", hexId],
      ["__refl_typename", nextAddress(), "String", className],
      ["__refl_typeids", nextAddress(), "Int64Array", null],
    ];

    return [...dataSection, ...entries];
  }

  private buildClassNode(
    name: string,
    baseClass: string | null,
    methods: MethodInfo[],
    properties: PropertyInfo[],
    constructorInfo?: {
      parameters: Array<{ name: string; type: string }>;
      body: ASTNode;
    },
  ): ClassDeclarationNode {
    const decorators: DecoratorNode[] = [];
    return {
      kind: ASTNodeKind.ClassDeclaration,
      name,
      baseClass,
      decorators,
      properties: properties.map((prop) => prop.node),
      methods: methods.map((method) => method.node),
      constructor: constructorInfo,
    } as ClassDeclarationNode;
  }

  private classesToProgram(
    nodes: ClassDeclarationNode[],
    topLevelConstNodes?: VariableDeclarationNode[],
  ): ProgramNode {
    const statements: ASTNode[] = [...(topLevelConstNodes ?? []), ...nodes];
    return {
      kind: ASTNodeKind.Program,
      statements,
    };
  }
}

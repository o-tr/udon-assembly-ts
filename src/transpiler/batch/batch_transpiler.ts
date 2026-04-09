/**
 * Batch transpiler orchestrator
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExternRegistryFromFiles } from "../codegen/extern_registry.js";
import { appendReflectionData } from "../codegen/reflection.js";
import { TACToUdonConverter } from "../codegen/tac_to_udon/index.js";
import { UdonAssembler } from "../codegen/udon_assembler.js";
import { ErrorCollector } from "../errors/error_collector.js";
import {
  AggregateTranspileError,
  DuplicateTopLevelConstError,
} from "../errors/transpile_errors.js";
import { computeExposedLabels } from "../exposed_labels.js";
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
import type { TypeMapper } from "../frontend/type_mapper.js";
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
  UASM_RUNTIME_LIMIT,
} from "../heap_limits.js";
import { ASTToTACConverter } from "../ir/ast_to_tac/index.js";
import { computeFingerprint, TACOptimizer } from "../ir/optimizer/index.js";
import { buildUdonBehaviourLayouts } from "../ir/udon_behaviour_layout.js";
import { DependencyResolver } from "./dependency_resolver.js";
import { discoverTypeScriptFiles } from "./file_discovery.js";

// ---- Cache types ----

interface FileCacheEntry {
  mtime: number;
  hash: string;
}

interface CacheV3 {
  version: 3;
  transpilerHash: string;
  files: Record<string, FileCacheEntry>;
  entryPoints: Record<string, { usedFiles: string[] }>;
}

interface OutputCacheEntry {
  key: string;
  uasm: string;
  warnings?: string[];
}

// ---- Transpiler identity hash ----
// Computed once per process: a SHA-256 over all transpiler source / dist files.
// When the transpiler code itself changes, all caches are invalidated.

let _transpilerHash: string | undefined;

function hashDirectoryRecursive(hash: crypto.Hash, dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hashDirectoryRecursive(hash, fullPath);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
      hash.update(fullPath);
      hash.update(fs.readFileSync(fullPath));
    }
  }
}

function getTranspilerHash(): string {
  if (_transpilerHash !== undefined) return _transpilerHash;
  // batch_transpiler.ts is in src/transpiler/batch/ (or dist/transpiler/batch/)
  // Go up one level to reach the transpiler root directory.
  const thisFile = fileURLToPath(import.meta.url);
  const transpilerRoot = path.resolve(path.dirname(thisFile), "..");
  const hash = crypto.createHash("sha256");
  hashDirectoryRecursive(hash, transpilerRoot);
  _transpilerHash = hash.digest("hex");
  return _transpilerHash;
}

// ---- End cache types ----

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
  warnings?: string[];
}

export interface BatchResult {
  outputs: BatchFileResult[];
}

export class BatchTranspiler {
  transpile(options: BatchTranspilerOptions): BatchResult {
    const errorCollector = new ErrorCollector();
    const parser = new TypeScriptParser(errorCollector);
    const registry = new ClassRegistry();
    const typeMapper = parser.typeMapper;
    const cachePath = path.join(options.sourceDir, ".transpiler-cache.json");
    const cache = this.loadCache(cachePath);

    const rawFiles = discoverTypeScriptFiles({
      sourceDir: options.sourceDir,
      excludeDirs: options.excludeDirs,
    });
    const files = rawFiles.map((f) => fs.realpathSync(f));
    const fileSet = new Set(files);

    // Register all source files upfront so that registry.getEntryPoints()
    // can identify entry files without a separate ts.createSourceFile() pass.
    const parseAndRegisterFile = (
      filePath: string,
      label?: string,
    ): boolean => {
      try {
        const source = fs.readFileSync(filePath, "utf8");
        const program = parser.parse(source, filePath);
        registry.registerFromProgram(program, filePath, source);
        return true;
      } catch (e) {
        if (options?.verbose) {
          const prefix = label ? `${label} ` : "";
          console.warn(
            `Failed to read/parse ${prefix}${filePath}: ${e instanceof Error ? e.message : e}`,
          );
        }
        return false;
      }
    };

    const transpilableSourceFiles = files.filter(isTranspilableSource);
    let sourceFileCount = 0;
    for (const filePath of transpilableSourceFiles) {
      if (parseAndRegisterFile(filePath)) sourceFileCount++;
    }

    // Derive entry files from registry instead of discoverEntryFilesUsingTS
    const entryFiles = [
      ...new Set(registry.getEntryPoints().map((ep) => ep.filePath)),
    ];

    const resolver = new DependencyResolver(options.sourceDir, {
      allowCircular: options.allowCircular,
    });
    resolver.setImportCache(parser.getImportCache());
    const reachable = new Set<string>();
    const fallbackDeps = new Set<string>();
    const includeExternal = options.includeExternalDependencies !== false;
    if (options?.verbose) {
      console.log(
        `Discovered ${files.length} TypeScript files, ${entryFiles.length} entry points.`,
      );
    }
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

    // Register any external files discovered via dependency resolution
    // that were not in the original sourceDir file set.
    let externalFileCount = 0;
    if (includeExternal && reachable.size > 0) {
      for (const reachableFile of reachable) {
        if (
          !fileSet.has(reachableFile) &&
          isTranspilableSource(reachableFile)
        ) {
          if (parseAndRegisterFile(reachableFile, "external dependency")) {
            externalFileCount++;
          }
        }
      }
    }

    const cacheFiles =
      entryFiles.length > 0 && reachable.size > 0
        ? Array.from(reachable)
        : files;

    buildExternRegistryFromFiles(cacheFiles);
    if (options?.verbose) {
      const totalRegisteredFiles = sourceFileCount + externalFileCount;
      console.log(
        `registered ${registry.getAllClasses().length} classes from ${totalRegisteredFiles} files (${sourceFileCount} source, ${externalFileCount} external).`,
      );
    }
    const changedFiles = this.getChangedFiles(cacheFiles, cache);
    const entryFilesToCompile = new Set<string>(entryFiles);
    if (cache) {
      entryFilesToCompile.clear();
      for (const entryFile of entryFiles) {
        try {
          // Tier 3: Use recorded usedFiles when available (faster, avoids full
          // compilationOrder traversal for unchanged entry points).
          const entryClass = registry
            .getEntryPoints()
            .find((ep) => ep.filePath === entryFile);
          const cachedUsedFiles =
            entryClass && cache.entryPoints[entryClass.name]?.usedFiles;
          const filesToCheck = cachedUsedFiles
            ? cachedUsedFiles
            : resolver.getCompilationOrder(entryFile);
          const hasChanges = filesToCheck.some((file) =>
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
    if (options?.verbose) {
      console.log(`Inheritance validation completed.`);
    }

    if (errorCollector.hasErrors()) {
      throw new AggregateTranspileError(errorCollector.getErrors());
    }

    if (entryFilesToCompile.size === 0) {
      this.saveCache(cachePath, cacheFiles, cache?.entryPoints ?? {}, cache);
      return { outputs: [] };
    }

    const outputs: BatchFileResult[] = [];
    const callAnalyzer = new CallAnalyzer(registry);
    const methodUsage =
      options.optimize === true
        ? new MethodUsageAnalyzer(registry).analyze()
        : null;

    const allClasses = registry.getAllClasses();
    const udonBehaviourClasses = new Set(
      allClasses
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
      allClasses.map((cls) => ({
        name: cls.name,
        isUdonBehaviour: udonBehaviourClasses.has(cls.name),
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

    const rawExt = options.outputExtension ?? "tasm";
    const normalized = rawExt.trim().toLowerCase();
    const sanitized = normalized.replace(/^\.+/, "").replace(/[/\\]/g, "");
    const ext = sanitized.length > 0 ? sanitized : "tasm";
    if (ext !== "tasm" && ext !== "uasm") {
      throw new Error(
        `Unsupported outputExtension "${ext}". Supported values: "tasm", "uasm".`,
      );
    }
    const heapLimit =
      options.heapLimit ?? (ext === "tasm" ? TASM_HEAP_LIMIT : UASM_HEAP_LIMIT);

    const optCacheDir = path.join(options.sourceDir, ".transpiler-optcache");
    // Carry forward entryPoints metadata for skipped (cached) entry points
    const entryPointsCache: Record<string, { usedFiles: string[] }> = {
      ...(cache?.entryPoints ?? {}),
    };

    for (const entryPoint of registry.getEntryPoints()) {
      if (!entryFilesToCompile.has(entryPoint.filePath)) {
        continue;
      }
      if (options?.verbose) {
        console.log(`Transpiling entry point: ${entryPoint.name}`);
      }
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
      if (options?.verbose) {
        console.log(
          `  - Collected ${filteredInlineClassNames.length} inline classes.`,
        );
      }

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
      if (options?.verbose) {
        console.log(
          `  - Collected ${entryPointMethods.length} methods, ${mergedProperties.length} properties, ${filteredInlineClassNames.length} inline classes.`,
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
      const tacConverter = new ASTToTACConverter(
        symbolTable,
        parser.getEnumRegistry(),
        udonBehaviourClasses,
        udonBehaviourLayouts,
        registry,
        {
          useStringBuilder: options.useStringBuilder,
          typeMapper,
        },
      );
      let tacInstructions = tacConverter.convert(methodProgram);
      if (options?.verbose) {
        console.log(
          `  - Generated ${tacInstructions.length} TAC instructions.`,
        );
      }

      // Tier 2: Build output cache key from pre-optimization TAC fingerprint.
      // computeExposedLabels == computeExportLabels, so compute once and reuse.
      const exposedLabels = computeExposedLabels(
        registry,
        udonBehaviourLayouts,
        entryPoint.name,
      );
      const syncModes = new Map<string, string>();
      for (const prop of mergedProperties) {
        if (prop.syncMode) {
          syncModes.set(prop.name, prop.syncMode.toLowerCase());
        }
      }
      const reflect = options.reflect === true;
      const optimize = options.optimize === true;
      const useStringBuilder = options.useStringBuilder === true;
      const cacheFilePath = this.outputCacheFilePath(
        optCacheDir,
        entryPoint.name,
        reflect,
        optimize,
        useStringBuilder,
        ext,
      );
      const outputCacheKey = this.computeOutputCacheKey(
        computeFingerprint(tacInstructions),
        computeFingerprint(tacInstructions, 0x84222325),
        exposedLabels,
        entryPoint.name,
        filteredInlineClassNames,
        syncModes,
        entryPoint.behaviourSyncMode,
        reflect,
        optimize,
        useStringBuilder,
        ext,
      );
      const cachedOutput = this.loadOutputCache(cacheFilePath, outputCacheKey);
      if (cachedOutput !== null) {
        if (options?.verbose) {
          console.log(`  - Output cache hit for ${entryPoint.name}.`);
        }
        const outPath = path.join(
          options.outputDir,
          `${entryPoint.name}.${ext}`,
        );
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, cachedOutput.uasm, "utf8");
        outputs.push({
          className: entryPoint.name,
          outputPath: outPath,
          warnings: cachedOutput.warnings,
        });
        entryPointsCache[entryPoint.name] = {
          usedFiles: this.collectUsedFiles(
            entryPoint.filePath,
            entryPoint.name,
            filteredInlineClassNames,
            registry,
          ),
        };
        continue;
      }

      // Output cache miss: run the full optimization + codegen pipeline.
      if (options.optimize === true) {
        const optimizer = new TACOptimizer();
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
        dataSectionWithTypes = appendReflectionData(
          dataSectionWithTypes,
          entryPoint.name,
        );
      }

      const assembler = new UdonAssembler();
      const uasm = assembler.assemble(
        udonInstructions,
        externSignatures,
        dataSectionWithTypes,
        syncModes,
        entryPoint.behaviourSyncMode,
        exposedLabels, // same as computeExportLabels(...)
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
        ext,
      );

      const outPath = path.join(options.outputDir, `${entryPoint.name}.${ext}`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, uasm, "utf8");

      const assemblerWarnings = assembler.getWarnings();
      const warnings =
        assemblerWarnings.length > 0 ? assemblerWarnings : undefined;
      // Tier 2: Save assembled output to cache.
      this.saveOutputCache(cacheFilePath, {
        key: outputCacheKey,
        uasm,
        warnings,
      });
      // Tier 3: Record which files contributed to this entry point.
      entryPointsCache[entryPoint.name] = {
        usedFiles: this.collectUsedFiles(
          entryPoint.filePath,
          entryPoint.name,
          filteredInlineClassNames,
          registry,
        ),
      };
      outputs.push({
        className: entryPoint.name,
        outputPath: outPath,
        warnings,
      });
    }

    if (errorCollector.hasErrors()) {
      throw new AggregateTranspileError(errorCollector.getErrors());
    }

    this.saveCache(cachePath, cacheFiles, entryPointsCache, cache);
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
    outputExt?: string,
  ): void {
    heapLimit = heapLimit ?? UASM_HEAP_LIMIT;
    const resolvedUsage = heapUsage ?? computeHeapUsage(dataSection);
    if (outputExt === "uasm" && resolvedUsage > UASM_RUNTIME_LIMIT) {
      console.warn(
        `UASM heap usage ${resolvedUsage} exceeds Udon runtime threshold ${UASM_RUNTIME_LIMIT} for ${entryPointName}.`,
      );
    }
    if (resolvedUsage <= heapLimit) return;

    const breakdown = buildHeapUsageTreeBreakdown(
      usageByClass,
      resolvedUsage,
      entryPointName,
      callAnalyzer,
      registry,
    );
    const formatLabel = outputExt === "tasm" ? "TASM" : "UASM";
    const messageParts = [
      `${formatLabel} heap usage ${resolvedUsage} exceeds limit ${heapLimit} for ${entryPointName}.`,
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
    udonBehaviourClasses: ReadonlySet<string>,
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
    udonBehaviourClasses: ReadonlySet<string>,
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
      { useStringBuilder, typeMapper },
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
      dataSectionWithTypes = appendReflectionData(
        dataSectionWithTypes,
        entryPointName,
      );
    }
    return computeHeapUsage(dataSectionWithTypes);
  }

  private loadCache(cachePath: string): CacheV3 | null {
    try {
      if (!fs.existsSync(cachePath)) return null;
      const raw = fs.readFileSync(cachePath, "utf8");
      const parsed = JSON.parse(raw);
      // v1 format: plain Record<string, number> — treat as cold cache
      if (!parsed || typeof parsed !== "object" || !("version" in parsed)) {
        return null;
      }
      const currentHash = getTranspilerHash();
      // v2 format: { version: 2, files: ... } — upgrade to v3
      if ((parsed as { version: number }).version === 2) {
        // No transpilerHash in v2, so file-level entries can be reused
        // but all entry points must recompile.
        return {
          version: 3,
          transpilerHash: currentHash,
          files:
            (parsed as { files: Record<string, FileCacheEntry> }).files ?? {},
          entryPoints: {},
        };
      }
      if ((parsed as { version: number }).version === 3) {
        const cache = parsed as CacheV3;
        // Transpiler code changed → invalidate everything
        if (cache.transpilerHash !== currentHash) {
          return null;
        }
        return cache;
      }
      return null;
    } catch {
      return null;
    }
  }

  private saveCache(
    cachePath: string,
    files: string[],
    entryPoints: Record<string, { usedFiles: string[] }>,
    existingCache: CacheV3 | null,
  ): void {
    const snapshot: Record<string, FileCacheEntry> = {};
    for (const file of files) {
      try {
        const mtime = fs.statSync(file).mtimeMs;
        // Reuse cached hash if mtime unchanged, otherwise compute fresh
        const cachedEntry = existingCache?.files[file];
        const hash =
          cachedEntry && cachedEntry.mtime === mtime
            ? cachedEntry.hash
            : crypto
                .createHash("sha256")
                .update(fs.readFileSync(file))
                .digest("hex");
        snapshot[file] = { mtime, hash };
      } catch {
        // ignore unreadable files
      }
    }
    const cache: CacheV3 = {
      version: 3,
      transpilerHash: getTranspilerHash(),
      files: snapshot,
      entryPoints,
    };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");
  }

  private getChangedFiles(files: string[], cache: CacheV3 | null): Set<string> {
    const changed = new Set<string>();
    if (!cache) {
      for (const file of files) changed.add(file);
      return changed;
    }
    for (const file of files) {
      try {
        const mtime = fs.statSync(file).mtimeMs;
        const entry = cache.files[file];
        if (!entry) {
          changed.add(file);
          continue;
        }
        // Fast path: mtime unchanged → no need to hash
        if (entry.mtime === mtime) continue;
        // mtime changed → compare content hash
        const hash = crypto
          .createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex");
        if (entry.hash !== hash) {
          changed.add(file);
        }
      } catch {
        changed.add(file);
      }
    }
    return changed;
  }

  // ---- Output cache helpers (Tier 2) ----

  // Finding 2: derive a slot path so different build configurations for the
  // same class each get their own cache file and don't evict each other.
  private outputCacheFilePath(
    cacheDir: string,
    className: string,
    reflect: boolean,
    optimize: boolean,
    useStringBuilder: boolean,
    ext: string,
  ): string {
    const slot = crypto
      .createHash("sha256")
      .update(
        [
          reflect ? "1" : "0",
          optimize ? "1" : "0",
          useStringBuilder ? "1" : "0",
          ext,
        ].join("|"),
      )
      .digest("hex")
      .slice(0, 8);
    return path.join(cacheDir, `${className}-${slot}.json`);
  }

  private computeOutputCacheKey(
    // Finding 1: accept two independent 32-bit FNV-1a fingerprints so the
    // effective TAC content signal is 64-bit, reducing collision probability
    // from ~2.3e-10 per pair to ~5.4e-20.
    tacFp1: number,
    tacFp2: number,
    exposedLabels: Set<string>,
    entryClassName: string,
    inlineClassNames: string[],
    syncModes: Map<string, string>,
    behaviourSyncMode: string | undefined,
    reflect: boolean,
    optimize: boolean,
    useStringBuilder: boolean,
    ext: string,
  ): string {
    const tacHash =
      (tacFp1 >>> 0).toString(16).padStart(8, "0") +
      (tacFp2 >>> 0).toString(16).padStart(8, "0");
    const sortedExposed = [...exposedLabels].sort().join(",");
    const sortedInline = [...inlineClassNames].sort().join(",");
    const sortedSync = [...syncModes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(",");
    const raw = [
      getTranspilerHash(),
      tacHash,
      sortedExposed,
      entryClassName,
      sortedInline,
      sortedSync,
      behaviourSyncMode ?? "",
      reflect ? "1" : "0",
      optimize ? "1" : "0",
      useStringBuilder ? "1" : "0",
      ext,
    ].join("|");
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  private loadOutputCache(
    filePath: string,
    expectedKey: string,
  ): OutputCacheEntry | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const entry = JSON.parse(
        fs.readFileSync(filePath, "utf8"),
      ) as OutputCacheEntry;
      return entry.key === expectedKey ? entry : null;
    } catch {
      return null;
    }
  }

  private saveOutputCache(filePath: string, entry: OutputCacheEntry): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(entry), "utf8");
    } catch {
      // Non-fatal: if we can't write the cache, compilation still succeeds
    }
  }

  // ---- Dependency tracking helper (Tier 3) ----

  private collectUsedFiles(
    entryFilePath: string,
    entryClassName: string,
    inlineClassNames: string[],
    registry: ClassRegistry,
  ): string[] {
    const used = new Set<string>([entryFilePath]);
    // Add the file for a class and all its base classes.
    const addWithInheritance = (className: string) => {
      for (const name of [
        className,
        ...registry.getInheritanceChain(className),
      ]) {
        const meta = registry.getClass(name);
        if (meta?.filePath) used.add(meta.filePath);
      }
    };
    addWithInheritance(entryClassName);
    for (const name of inlineClassNames) {
      addWithInheritance(name);
    }
    return [...used];
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

    let queueIdx = 0;
    while (queueIdx < queue.length) {
      const current = queue[queueIdx++];
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

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
import { computeFingerprintPair, TACOptimizer } from "../ir/optimizer/index.js";
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
  transpilerHash?: string;
}

// ---- Transpiler identity hash ----
// Computed once per process: a SHA-256 over all transpiler source / dist files.
// When the transpiler code itself changes, all caches are invalidated.

let _transpilerHash: string | undefined;

function hashDirectoryRecursive(
  hash: crypto.Hash,
  dir: string,
  root: string,
  visited: Set<string>,
): void {
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (visited.has(realDir)) return;
  visited.add(realDir);
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
      hashDirectoryRecursive(hash, fullPath, root, visited);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
      hash.update(path.relative(root, fullPath));
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
  hashDirectoryRecursive(hash, transpilerRoot, transpilerRoot, new Set());
  _transpilerHash = hash.digest("hex");
  return _transpilerHash;
}

/**
 * Reset the cached transpiler hash so it is recomputed on the next call to
 * getTranspilerHash(). Long-lived processes (watch servers, Vite plugins, etc.)
 * should call this after the transpiler source is rebuilt or hot-reloaded to
 * ensure Tier-1 / Tier-2 cache invalidation remains accurate.
 */
export function resetTranspilerHash(): void {
  _transpilerHash = undefined;
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
    // Include usedFiles from prior cache entries so changes to transitive
    // dependencies not reachable via the import graph (e.g. base-class files
    // in the same directory with no explicit imports) are still detected.
    const trackedFiles = new Set(cacheFiles);
    if (cache?.entryPoints) {
      for (const ep of Object.values(cache.entryPoints)) {
        for (const f of ep.usedFiles) trackedFiles.add(f);
      }
    }
    const { changed: changedFiles, computedHashes } = this.getChangedFiles(
      Array.from(trackedFiles),
      cache,
    );
    const entryFilesToCompile = new Set<string>(entryFiles);
    if (cache) {
      entryFilesToCompile.clear();
      for (const entryFile of entryFiles) {
        try {
          // Tier 3: Use recorded usedFiles when available (faster, avoids full
          // compilationOrder traversal for unchanged entry points).
          // Bootstrap invariant: to add a new dependency to an entry point,
          // some file already tracked in usedFiles must be modified to
          // reference it. That modification is detected as a change, triggering
          // a recompile and updating usedFiles to include the new file.
          // The stale usedFiles set is therefore safe: any source edit that
          // introduces a new transitive dependency also touches an already-
          // tracked file. The gap exists only on the single transitional run.
          // Collect usedFiles from ALL entry points in this file (a file
          // may contain multiple @UdonBehaviour classes with different deps).
          const entryClasses = registry
            .getEntryPoints()
            .filter((ep) => ep.filePath === entryFile);
          const usedFilesUnion = new Set<string>();
          let hasAnyCachedUsedFiles = false;
          for (const ec of entryClasses) {
            const uf = cache.entryPoints[ec.name]?.usedFiles;
            if (uf) {
              hasAnyCachedUsedFiles = true;
              for (const f of uf) usedFilesUnion.add(f);
            }
          }
          const filesToCheck = hasAnyCachedUsedFiles
            ? Array.from(usedFilesUnion)
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
    // Sweep stale output-cache entries when there is no prior cache or when the
    // transpiler hash changed (including v2→v3 upgrades where loadCache injects
    // the current hash but old optcache entries still carry the prior version's).
    const currentTranspilerHash = getTranspilerHash();
    if (cache === null || cache.transpilerHash !== currentTranspilerHash) {
      this.sweepOutputCache(optCacheDir);
    }

    const reflect = options.reflect === true;
    const optimize = options.optimize === true;
    const useStringBuilder = options.useStringBuilder === true;

    // Record slot files for ALL entry points (including skipped ones) so
    // sweepUnusedSlotFiles does not delete cache files for cached entries.
    const activeSlotFiles = new Set<string>();
    for (const ep of registry.getEntryPoints()) {
      activeSlotFiles.add(
        this.outputCacheFilePath(
          optCacheDir,
          ep.name,
          reflect,
          optimize,
          useStringBuilder,
          ext,
          heapLimit,
        ),
      );
    }

    if (entryFilesToCompile.size === 0) {
      this.sweepUnusedSlotFiles(optCacheDir, activeSlotFiles);
      // Save trackedFiles (not just cacheFiles) so transitive dependencies
      // discovered in prior runs (e.g. base-class files with no explicit import)
      // continue to have their hashes persisted for future change detection.
      this.saveCache(
        cachePath,
        Array.from(trackedFiles),
        cache?.entryPoints ?? {},
        cache,
        computedHashes,
      );
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

      // Resolve import-graph dependencies for Tier-3 usedFiles tracking.
      // May fail for entry points whose dependency graph couldn't be built;
      // in that case, fall back to class-level tracking only.
      let entryCompilationOrder: string[] | undefined;
      try {
        entryCompilationOrder = resolver.getCompilationOrder(
          entryPoint.filePath,
        );
      } catch {
        // non-fatal: class-level tracking still works
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
      const cacheFilePath = this.outputCacheFilePath(
        optCacheDir,
        entryPoint.name,
        reflect,
        optimize,
        useStringBuilder,
        ext,
        heapLimit,
      );
      const [tacFp1, tacFp2] = computeFingerprintPair(tacInstructions);
      const outputCacheKey = this.computeOutputCacheKey(
        tacFp1,
        tacFp2,
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
        for (const w of cachedOutput.warnings ?? []) console.warn(w);
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
            entryCompilationOrder,
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

      const heapWarnings = this.ensureHeapWithinLimit(
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
      const assemblerWarnings = assembler.getWarnings();
      for (const w of heapWarnings) console.warn(w);
      for (const w of assemblerWarnings) console.warn(w);

      const outPath = path.join(options.outputDir, `${entryPoint.name}.${ext}`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, uasm, "utf8");

      const allWarnings = [...heapWarnings, ...assemblerWarnings];
      const warnings = allWarnings.length > 0 ? allWarnings : undefined;
      // Tier 2: Save assembled output to cache.
      this.saveOutputCache(cacheFilePath, {
        key: outputCacheKey,
        uasm,
        warnings,
        transpilerHash: getTranspilerHash(),
      });
      // Tier 3: Record which files contributed to this entry point.
      entryPointsCache[entryPoint.name] = {
        usedFiles: this.collectUsedFiles(
          entryPoint.filePath,
          entryPoint.name,
          filteredInlineClassNames,
          registry,
          entryCompilationOrder,
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

    // Remove output-cache slot files that were not used in this run (e.g. from
    // a prior build with different options). This prevents unbounded growth of
    // .transpiler-optcache/ when build flags cycle in CI.
    this.sweepUnusedSlotFiles(optCacheDir, activeSlotFiles);

    // Union trackedFiles (which already includes prior usedFiles) with new
    // entryPointsCache usedFiles so freshly-discovered transitive dependencies
    // (e.g. base-class files with no explicit import) are hashed on first run.
    const allTrackedFiles = new Set(trackedFiles);
    for (const ep of Object.values(entryPointsCache)) {
      for (const f of ep.usedFiles) allTrackedFiles.add(f);
    }
    this.saveCache(
      cachePath,
      Array.from(allTrackedFiles),
      entryPointsCache,
      cache,
      computedHashes,
    );
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
  ): string[] {
    heapLimit = heapLimit ?? UASM_HEAP_LIMIT;
    const resolvedUsage = heapUsage ?? computeHeapUsage(dataSection);
    const collected: string[] = [];
    if (outputExt === "uasm" && resolvedUsage > UASM_RUNTIME_LIMIT) {
      collected.push(
        `UASM heap usage ${resolvedUsage} exceeds Udon runtime threshold ${UASM_RUNTIME_LIMIT} for ${entryPointName}.`,
      );
    }
    if (resolvedUsage <= heapLimit) return collected;

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
    collected.push(messageParts.join("\n"));
    return collected;
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
      // v2 format: { version: 2, files: ... } — treat as cold cache.
      // v2 entries lack both transpilerHash and per-file hash, so there is
      // nothing worth preserving. Returning null forces a full rebuild and
      // the caller's cache===null check sweeps any stale optcache entries.
      if ((parsed as { version: number }).version === 2) {
        return null;
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
    computedHashes: Map<string, { hash: string; mtime: number }>,
  ): void {
    const snapshot: Record<string, FileCacheEntry> = {};
    for (const file of files) {
      try {
        const mtime = fs.statSync(file).mtimeMs;
        const cachedEntry = existingCache?.files[file];
        // Use the hash computed by getChangedFiles only if the file has not
        // been modified since (mtime must match to guard against the race
        // window between the two calls). Fall back to the previous cached
        // hash if mtime is unchanged, or compute fresh otherwise.
        const precomputed = computedHashes.get(file);
        const hash =
          (precomputed && precomputed.mtime === mtime
            ? precomputed.hash
            : undefined) ??
          (cachedEntry && cachedEntry.mtime === mtime
            ? cachedEntry.hash
            : crypto
                .createHash("sha256")
                .update(fs.readFileSync(file))
                .digest("hex"));
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
    try {
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");
    } catch {
      // Non-fatal: a cache write failure should not abort an otherwise
      // successful build.
    }
  }

  private getChangedFiles(
    files: string[],
    cache: CacheV3 | null,
  ): {
    changed: Set<string>;
    computedHashes: Map<string, { hash: string; mtime: number }>;
  } {
    const changed = new Set<string>();
    const computedHashes = new Map<string, { hash: string; mtime: number }>();
    if (!cache) {
      for (const file of files) {
        changed.add(file);
        try {
          // stat before read (consistent with cache-hit branch) to avoid
          // TOCTOU: if the file is modified between the two calls, mtime
          // reflects content that was actually hashed.
          const mtime = fs.statSync(file).mtimeMs;
          const hash = crypto
            .createHash("sha256")
            .update(fs.readFileSync(file))
            .digest("hex");
          computedHashes.set(file, { hash, mtime });
        } catch {
          // ignore; saveCache will handle unreadable files
        }
      }
      return { changed, computedHashes };
    }
    for (const file of files) {
      try {
        const mtime = fs.statSync(file).mtimeMs;
        const entry = cache.files[file];
        if (!entry) {
          // Stash hash for saveCache so it doesn't need to re-read the file.
          const hash = crypto
            .createHash("sha256")
            .update(fs.readFileSync(file))
            .digest("hex");
          computedHashes.set(file, { hash, mtime });
          changed.add(file);
          continue;
        }
        // Fast path: mtime unchanged → no need to hash
        if (entry.mtime === mtime) continue;
        // mtime changed → compare content hash; stash result for saveCache
        const hash = crypto
          .createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex");
        computedHashes.set(file, { hash, mtime });
        if (entry.hash !== hash) {
          changed.add(file);
        }
      } catch {
        changed.add(file);
      }
    }
    return { changed, computedHashes };
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
    heapLimit: number,
  ): string {
    const slot = crypto
      .createHash("sha256")
      .update(
        [
          reflect ? "1" : "0",
          optimize ? "1" : "0",
          useStringBuilder ? "1" : "0",
          ext,
          heapLimit.toString(),
        ].join("|"),
      )
      .digest("hex")
      .slice(0, 16);
    return path.join(cacheDir, `${className}-${slot}.json`);
  }

  private computeOutputCacheKey(
    // Two seeded FNV-1a fingerprints (correlated, not independent) combined
    // into ~48-52 effective bits of collision resistance. Adequate here because
    // these values are fed into a SHA-256 outer key alongside many other fields.
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
      if (
        entry.key !== expectedKey ||
        typeof entry.uasm !== "string" ||
        !entry.uasm
      ) {
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  private sweepOutputCache(optCacheDir: string): void {
    try {
      if (!fs.existsSync(optCacheDir)) return;
      const currentHash = getTranspilerHash();
      for (const file of fs.readdirSync(optCacheDir)) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(optCacheDir, file);
        try {
          const entry = JSON.parse(
            fs.readFileSync(filePath, "utf8"),
          ) as OutputCacheEntry;
          if (!entry.transpilerHash || entry.transpilerHash !== currentHash) {
            fs.unlinkSync(filePath);
          }
        } catch {
          try {
            fs.unlinkSync(filePath);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* Non-fatal */
    }
  }

  private sweepUnusedSlotFiles(
    optCacheDir: string,
    activeSlotFiles: Set<string>,
  ): void {
    try {
      if (!fs.existsSync(optCacheDir)) return;
      for (const file of fs.readdirSync(optCacheDir)) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(optCacheDir, file);
        if (!activeSlotFiles.has(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* Non-fatal */
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
    importedFiles?: string[],
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
    // Include explicitly-imported files (e.g. utility files with top-level
    // consts or non-inline classes) so their changes trigger recompilation.
    if (importedFiles) {
      for (const f of importedFiles) used.add(f);
    }
    return [...used];
  }

  private pickEntryMethod(methods: readonly MethodInfo[]): MethodInfo | null {
    const start = methods.find((method) => method.name === "Start");
    if (start) return start;
    const underscore = methods.find((method) => method.name === "_start");
    if (underscore) return underscore;
    return null;
  }

  private orderEntryMethods(methods: readonly MethodInfo[]): MethodInfo[] {
    const entry = this.pickEntryMethod(methods);
    if (!entry) return [...methods];
    return [entry, ...methods.filter((method) => method !== entry)];
  }

  private filterMethodsByUsage(
    methods: readonly MethodInfo[],
    className: string,
    usage: Map<string, Set<string>> | null,
  ): MethodInfo[] {
    if (!usage) return [...methods];
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
    methods: readonly MethodInfo[],
    properties: readonly PropertyInfo[],
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

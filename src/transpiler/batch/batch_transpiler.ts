/**
 * Batch transpiler orchestrator
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const PROF = process.env.UDON_PROFILE === "1";
function pmark(): number {
  return PROF ? performance.now() : 0;
}
function pend(label: string, t0: number, extra = ""): void {
  if (PROF) {
    const dt = (performance.now() - t0).toFixed(1);
    const suffix = extra ? ` ${extra}` : "";
    console.log(`[prof] ${label}: ${dt}ms${suffix}`);
  }
}

import { buildExternRegistryFromFiles } from "../codegen/extern_registry.js";
import { appendReflectionData } from "../codegen/reflection.js";
import { TACToUdonConverter } from "../codegen/tac_to_udon/index.js";
import { UdonAssembler } from "../codegen/udon_assembler.js";
import { ErrorCollector } from "../errors/error_collector.js";
import {
  AggregateTranspileError,
  DuplicateTopLevelConstError,
  formatWarnings,
  type TranspileWarning,
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
import { resolveDeferredTypes } from "../frontend/post_parse_resolver.js";
import { SymbolTable } from "../frontend/symbol_table.js";
import { TypeCheckerContext } from "../frontend/type_checker_context.js";
import type { TypeSymbol } from "../frontend/type_symbols.js";
import {
  type ASTNode,
  ASTNodeKind,
  type ClassDeclarationNode,
  type DecoratorNode,
  type ProgramNode,
  type VariableDeclarationNode,
} from "../frontend/types.js";
import {
  buildSimpleHeapBreakdown,
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
  /**
   * Structured diagnostics emitted by tacConverter (warnAt) for this entry
   * point. Saved per entry so the "no files changed" early-return path can
   * still populate BatchResult.diagnostics by replaying the cached entries.
   * NOTE: on a per-entry cache hit (line ~629), tacConverter already runs
   * and re-adds these to errorCollector, so the cache-hit path does NOT
   * replay from here — it would double-count.
   */
  diagnostics?: TranspileWarning[];
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
  /**
   * When true, suppress the terminal `console.warn(formatWarnings(...))`
   * emission. Structured diagnostics are still returned on
   * `BatchResult.diagnostics`. Per-entry per-file warnings from assembler /
   * heap checks are unaffected (they remain on stderr).
   */
  silent?: boolean;
}

export interface BatchFileResult {
  className: string;
  outputPath: string;
  warnings?: string[];
}

export interface BatchResult {
  outputs: BatchFileResult[];
  diagnostics?: TranspileWarning[];
}

export class BatchTranspiler {
  transpile(options: BatchTranspilerOptions): BatchResult {
    const _profTopStart = pmark();
    const errorCollector = new ErrorCollector();
    const cachePath = path.join(options.sourceDir, ".transpiler-cache.json");
    const cache = this.loadCache(cachePath);

    const _profDiscoverStart = pmark();
    const rawFiles = discoverTypeScriptFiles({
      sourceDir: options.sourceDir,
      excludeDirs: options.excludeDirs,
    });
    const files = rawFiles.map((f) => fs.realpathSync(f));
    const fileSet = new Set(files);

    const transpilableSourceFiles = files.filter(isTranspilableSource);
    pend(
      "discover",
      _profDiscoverStart,
      `files=${files.length} transpilable=${transpilableSourceFiles.length}`,
    );

    const _profReadStart = pmark();
    // Build a shared TypeCheckerContext for all source files so that
    // cross-file type resolution works during parsing.
    const inMemorySources: Record<string, string> = {};
    for (const filePath of transpilableSourceFiles) {
      inMemorySources[filePath] = fs.readFileSync(filePath, "utf8");
    }
    pend("read-sources", _profReadStart);
    const _profCtxStart = pmark();
    const checkerContext =
      transpilableSourceFiles.length > 0
        ? TypeCheckerContext.create({
            rootNames: transpilableSourceFiles,
            inMemorySources,
          })
        : undefined;
    pend("checker-context-create-initial", _profCtxStart);
    const parser = new TypeScriptParser(errorCollector, checkerContext);
    const registry = new ClassRegistry();
    const typeMapper = parser.typeMapper;

    // Register all source files upfront so that registry.getEntryPoints()
    // can identify entry files without a separate ts.createSourceFile() pass.
    const parsedPrograms = new Map<string, ProgramNode>();
    const parseAndRegisterFile = (filePath: string): void => {
      const source =
        inMemorySources[filePath] ?? fs.readFileSync(filePath, "utf8");
      const program = parser.parse(source, filePath);
      parsedPrograms.set(filePath, program);
      registry.registerFromProgram(program, filePath, source);
    };

    const _profParseStart = pmark();
    let sourceFileCount = 0;
    for (const filePath of transpilableSourceFiles) {
      parseAndRegisterFile(filePath);
      sourceFileCount++;
    }
    pend("parse-initial", _profParseStart, `files=${sourceFileCount}`);

    // Derive entry files from registry instead of discoverEntryFilesUsingTS
    const entryFiles = [
      ...new Set(registry.getEntryPoints().map((ep) => ep.filePath)),
    ];

    const resolver = new DependencyResolver(options.sourceDir, {
      allowCircular: options.allowCircular,
    });
    resolver.setImportCache(parser.getImportCache());
    const reachable = new Set<string>();
    const includeExternal = options.includeExternalDependencies !== false;
    if (options?.verbose) {
      console.log(
        `Discovered ${files.length} TypeScript files, ${entryFiles.length} entry points.`,
      );
    }
    // Discover external dependencies iteratively (fixpoint) so imports
    // inside newly-discovered external files are also resolved.
    const _profFixpointStart = pmark();
    let externalFileCount = 0;
    let fixpointIter = 0;
    const allExternalRootNames: string[] = [];
    let previousReachableSize = -1;
    while (reachable.size !== previousReachableSize) {
      fixpointIter++;
      const _profIterStart = pmark();
      previousReachableSize = reachable.size;

      if (entryFiles.length > 0) {
        for (const entry of entryFiles) {
          const graph = resolver.buildGraph(entry);
          reachable.add(entry);
          for (const [k, deps] of graph.entries()) {
            reachable.add(k);
            for (const d of deps) reachable.add(d);
          }
        }
      }

      const externalFiles: string[] = [];
      if (includeExternal && reachable.size > 0) {
        for (const reachableFile of reachable) {
          if (
            !fileSet.has(reachableFile) &&
            isTranspilableSource(reachableFile)
          ) {
            externalFiles.push(reachableFile);
          }
        }
      }

      if (externalFiles.length === 0) {
        pend(
          `fixpoint-iter-${fixpointIter}`,
          _profIterStart,
          `external=0 (terminal)`,
        );
        break;
      }

      allExternalRootNames.push(...externalFiles);
      const allRootNames = [
        ...transpilableSourceFiles,
        ...allExternalRootNames,
      ];
      for (const filePath of externalFiles) {
        if (!inMemorySources[filePath]) {
          inMemorySources[filePath] = fs.readFileSync(filePath, "utf8");
        }
      }
      const _profCtxRebuild = pmark();
      const newCheckerContext = TypeCheckerContext.create({
        rootNames: allRootNames,
        inMemorySources,
        oldProgram: parser.checkerContext?.getProgram(),
      });
      pend(
        `fixpoint-iter-${fixpointIter}-ctx-rebuild`,
        _profCtxRebuild,
        `roots=${allRootNames.length}`,
      );
      if (parser.checkerContext) {
        newCheckerContext.setParent(parser.checkerContext);
      }
      parser.setCheckerContext(newCheckerContext);
      const _profIterParse = pmark();
      for (const reachableFile of externalFiles) {
        parseAndRegisterFile(reachableFile);
        externalFileCount++;
        fileSet.add(reachableFile);
      }
      pend(
        `fixpoint-iter-${fixpointIter}-parse`,
        _profIterParse,
        `external=${externalFiles.length}`,
      );
      resolver.setImportCache(parser.getImportCache());
      pend(
        `fixpoint-iter-${fixpointIter}`,
        _profIterStart,
        `external=${externalFiles.length}`,
      );
    }
    pend(
      "fixpoint-total",
      _profFixpointStart,
      `iters=${fixpointIter} external=${externalFileCount}`,
    );

    // All aliases (including cross-file forward references) are now
    // registered in `typeMapper`. Walk every parsed program to upgrade
    // placeholder types to their registered `InterfaceTypeSymbol`, then
    // re-register so the ClassRegistry's shallow `MethodInfo`/`PropertyInfo`
    // copies see the upgraded types as well.
    const _profDeferredStart = pmark();
    for (const [filePath, program] of parsedPrograms) {
      resolveDeferredTypes(program, typeMapper);
      const sourceText =
        inMemorySources[filePath] ?? fs.readFileSync(filePath, "utf8");
      registry.registerFromProgram(program, filePath, sourceText);
    }
    pend(
      "resolve-deferred-types",
      _profDeferredStart,
      `programs=${parsedPrograms.size}`,
    );

    const cacheFiles =
      entryFiles.length > 0 && reachable.size > 0
        ? Array.from(reachable)
        : files;

    const _profExternRegistry = pmark();
    buildExternRegistryFromFiles(cacheFiles);
    pend("extern-registry-build", _profExternRegistry);
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
        const hasChanges = filesToCheck.some((file) => changedFiles.has(file));
        if (hasChanges) {
          entryFilesToCompile.add(entryFile);
        }
      }
    }

    const _profValidate = pmark();
    const validator = new InheritanceValidator(registry, errorCollector);
    for (const entryPoint of registry.getEntryPoints()) {
      validator.validate(entryPoint.name);
    }
    pend("inheritance-validate", _profValidate);
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
      // Replay structured diagnostics from the per-entry output cache so that
      // BatchResult.diagnostics (used by CI gating, IDE integrations) is still
      // populated on unchanged rebuilds. The per-entry cache-hit path inside
      // the main loop does NOT replay because tacConverter reruns there and
      // re-adds them; this no-op early-return has no other source.
      const currentTranspilerHash = getTranspilerHash();
      for (const entry of registry.getEntryPoints()) {
        const slot = this.outputCacheFilePath(
          optCacheDir,
          entry.name,
          reflect,
          optimize,
          useStringBuilder,
          ext,
          heapLimit,
        );
        const cached = this.loadOutputCacheAny(slot);
        if (!cached?.diagnostics) continue;
        // Defensive guard for hand-edited optcache directories: skip entries
        // whose transpilerHash no longer matches this build.
        if (
          cached.transpilerHash &&
          cached.transpilerHash !== currentTranspilerHash
        ) {
          continue;
        }
        for (const d of cached.diagnostics) errorCollector.addWarning(d);
      }
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
      const diagnostics = errorCollector.getWarnings();
      if (diagnostics.length > 0 && !options.silent) {
        console.warn(formatWarnings(diagnostics));
      }
      // Close the top-level span before returning so this fully-cached
      // early-return path still emits a `transpile-total` line — otherwise
      // a no-op build looks like a hung profile run in the [prof] output.
      pend("transpile-total", _profTopStart, "all-cached");
      return diagnostics.length > 0
        ? { outputs: [], diagnostics }
        : { outputs: [] };
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
            type: p.type,
          })),
          returnType: m.returnType,
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
            type: param.type,
          })),
          returnType: method.returnType,
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
      const _profEntryStart = pmark();
      if (PROF) console.log(`[prof] >>> begin entry ${entryPoint.name}`);
      if (options?.verbose) {
        console.log(`Transpiling entry point: ${entryPoint.name}`);
      }
      const _profMerge = pmark();
      const mergedMethods = registry.getMergedMethods(entryPoint.name);
      const mergedProperties = registry.getMergedProperties(entryPoint.name);
      pend(`entry-${entryPoint.name}-merge-methods`, _profMerge);

      const _profCollectInline = pmark();
      const inlineClassNames = Array.from(
        this.collectReachableInlineClasses(
          entryPoint.name,
          callAnalyzer,
          registry,
        ),
      );
      pend(
        `entry-${entryPoint.name}-collect-inline`,
        _profCollectInline,
        `inline=${inlineClassNames.length}`,
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
      const entryCompilationOrder = resolver.getCompilationOrder(
        entryPoint.filePath,
      );

      const entryPointMethods = this.orderEntryMethods(
        this.filterMethodsByUsage(mergedMethods, entryPoint.name, methodUsage),
      );

      const symbolTable = new SymbolTable();
      for (const prop of mergedProperties) {
        symbolTable.addSymbol(prop.name, prop.type, false, false);
      }
      if (options?.verbose) {
        console.log(
          `  - Collected ${entryPointMethods.length} methods, ${mergedProperties.length} properties, ${filteredInlineClassNames.length} inline classes.`,
        );
      }

      const _profCollectConsts = pmark();
      let topLevelConsts: TopLevelConstInfo[];
      try {
        topLevelConsts = this.collectAllTopLevelConsts(
          entryPoint.filePath,
          filteredInlineClassNames,
          registry,
        );
      } catch (e) {
        if (this.collectDuplicateConstErrors(e, errorCollector)) {
          // Close the open per-entry spans before bailing on this entry so
          // every pmark() has a matching pend() — otherwise the duplicate-
          // const error path leaves orphan timers in the prof output.
          pend(
            `entry-${entryPoint.name}-collect-consts`,
            _profCollectConsts,
            "error=DuplicateTopLevelConst",
          );
          pend(`entry-${entryPoint.name}`, _profEntryStart, "error=skipped");
          continue;
        }
        throw e;
      }
      pend(
        `entry-${entryPoint.name}-collect-consts`,
        _profCollectConsts,
        `consts=${topLevelConsts.length}`,
      );
      for (const tlc of topLevelConsts) {
        if (!symbolTable.hasInCurrentScope(tlc.name)) {
          symbolTable.addSymbol(
            tlc.name,
            tlc.type,
            false,
            true,
            tlc.node.initializer,
          );
        }
      }

      const _profBuildProgram = pmark();
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
      pend(`entry-${entryPoint.name}-build-program`, _profBuildProgram);
      const tacConverter = new ASTToTACConverter(
        symbolTable,
        parser.getEnumRegistry(),
        udonBehaviourClasses,
        udonBehaviourLayouts,
        registry,
        {
          useStringBuilder: options.useStringBuilder,
          typeMapper,
          sourceFilePath: entryPoint.filePath,
          errorCollector,
          checkerContext: parser.checkerContext,
          checkerTypeResolver: parser.checkerTypeResolver,
        },
      );
      // Snapshot the shared collector so we can extract per-entry diagnostics
      // for the output cache (used on fully-cached subsequent runs).
      const diagnosticsBefore = errorCollector.getWarnings().length;
      const _profTacStart = pmark();
      let tacInstructions = tacConverter.convert(methodProgram);
      pend(
        `entry-${entryPoint.name}-ast-to-tac`,
        _profTacStart,
        `instr=${tacInstructions.length}`,
      );
      const entryDiagnostics = errorCollector
        .getWarnings()
        .slice(diagnosticsBefore);
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
        pend(`entry-${entryPoint.name}`, _profEntryStart, "cache=hit");
        continue;
      }

      // Output cache miss: run the full optimization + codegen pipeline.
      if (options.optimize === true) {
        const _profOpt = pmark();
        const optimizer = new TACOptimizer();
        tacInstructions = optimizer.optimize(tacInstructions, exposedLabels);
        pend(
          `entry-${entryPoint.name}-optimize`,
          _profOpt,
          `instr=${tacInstructions.length}`,
        );
      }

      const _profCodegen = pmark();
      const udonConverter = new TACToUdonConverter();
      const inlineClassNameSet = new Set(filteredInlineClassNames);
      const udonInstructions = udonConverter.convert(tacInstructions, {
        entryClassName: entryPoint.name,
        inlineClassNames: inlineClassNameSet,
      });
      pend(
        `entry-${entryPoint.name}-codegen`,
        _profCodegen,
        `instr=${udonInstructions.length}`,
      );
      const externSignatures = udonConverter.getExternSignatures();
      let dataSectionWithTypes = udonConverter.getDataSectionWithTypes();
      if (options.reflect === true) {
        dataSectionWithTypes = appendReflectionData(
          dataSectionWithTypes,
          entryPoint.name,
        );
      }

      const _profAssemble = pmark();
      const assembler = new UdonAssembler();
      const uasm = assembler.assemble(
        udonInstructions,
        externSignatures,
        dataSectionWithTypes,
        syncModes,
        entryPoint.behaviourSyncMode,
        exposedLabels, // same as computeExportLabels(...)
      );
      const heapWarnings: string[] = [];
      const heapUsage = computeHeapUsage(dataSectionWithTypes);
      if (ext === "uasm" && heapUsage > UASM_RUNTIME_LIMIT) {
        heapWarnings.push(
          `UASM heap usage ${heapUsage} exceeds Udon runtime threshold ${UASM_RUNTIME_LIMIT} for ${entryPoint.name}.`,
        );
      }
      if (heapUsage > heapLimit) {
        const formatLabel = ext === "tasm" ? "TASM" : "UASM";
        const breakdown = buildSimpleHeapBreakdown(
          udonConverter.getHeapUsageByClass(),
          heapUsage,
          entryPoint.name,
        );
        heapWarnings.push(
          `${formatLabel} heap usage ${heapUsage} exceeds limit ${heapLimit} for ${entryPoint.name}.\nHeap usage by class:\n${breakdown}`,
        );
      }
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
        diagnostics: entryDiagnostics.length > 0 ? entryDiagnostics : undefined,
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
      pend(
        `entry-${entryPoint.name}-assemble`,
        _profAssemble,
        `bytes=${uasm.length}`,
      );
      outputs.push({
        className: entryPoint.name,
        outputPath: outPath,
        warnings,
      });
      pend(`entry-${entryPoint.name}`, _profEntryStart, "cache=miss");
    }
    pend("transpile-total", _profTopStart);

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
    const diagnostics = errorCollector.getWarnings();
    if (diagnostics.length > 0 && !options.silent) {
      console.warn(formatWarnings(diagnostics));
    }
    return diagnostics.length > 0 ? { outputs, diagnostics } : { outputs };
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

  /**
   * Load a cache entry without verifying its output key. Used by the
   * no-changes early-return path to replay structured diagnostics: the
   * trackedFiles hash check already established that nothing changed, so
   * the cached diagnostics are still authoritative even if the key is not
   * re-derived here.
   */
  private loadOutputCacheAny(filePath: string): OutputCacheEntry | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as OutputCacheEntry;
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
        entryMeta?.node,
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
          inlineMeta.node,
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
      parameters: ReadonlyArray<{ name: string; type: TypeSymbol }>;
      body: ASTNode;
    },
    originalNode?: ClassDeclarationNode,
  ): ClassDeclarationNode {
    const decorators: DecoratorNode[] = [];
    if (originalNode) {
      return {
        ...originalNode,
        name,
        baseClass,
        decorators,
        properties: properties.map((prop) => prop.node),
        methods: methods.map((method) => method.node),
        constructor: constructorInfo,
      };
    }
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

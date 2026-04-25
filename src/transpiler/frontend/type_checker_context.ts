import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import type { ASTNode } from "./types.js";

type InMemorySources = Record<string, string> | Map<string, string>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "../../..");

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  experimentalDecorators: true,
  jsx: ts.JsxEmit.Preserve,
  allowJs: true,
  baseUrl: packageRoot,
  paths: {
    "@ootr/udon-assembly-ts": ["dist/index.js"],
    "@ootr/udon-assembly-ts/*": ["dist/*"],
  },
};

function normalizeFilePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.normalize(path.resolve(process.cwd(), filePath));
}

function toSourceMap(sources: InMemorySources): Map<string, string> {
  if (sources instanceof Map) {
    const mapped = new Map<string, string>();
    for (const [key, value] of sources.entries()) {
      mapped.set(normalizeFilePath(key), value);
    }
    return mapped;
  }
  const mapped = new Map<string, string>();
  for (const [key, value] of Object.entries(sources)) {
    mapped.set(normalizeFilePath(key), value);
  }
  return mapped;
}

// TypeScript lib files (lib.es*.d.ts etc.) are immutable for the lifetime of
// the process and are otherwise reparsed on every TypeCheckerContext.create()
// call. Caching the parsed SourceFiles cuts per-call program creation from
// ~350ms to ~175ms in measurements.
const libSourceFileCache = new Map<string, ts.SourceFile>();

function isLibSourceFile(fileName: string): boolean {
  return /[\\/]typescript[\\/]lib[\\/]lib\..*\.d\.ts$/.test(fileName);
}

function buildNodeId(
  filePath: string,
  start: number,
  end: number,
  syntaxKind: number,
): string {
  return `${normalizeFilePath(filePath)}#${start}:${end}:${syntaxKind}`;
}

export interface TypeCheckerContextOptions {
  rootNames: string[];
  inMemorySources?: InMemorySources;
  compilerOptions?: ts.CompilerOptions;
  oldProgram?: ts.Program;
}

export class TypeCheckerContext {
  private readonly checker: ts.TypeChecker;
  private readonly astToTsNode = new WeakMap<ASTNode, ts.Node>();
  private readonly tsNodeById = new Map<string, ts.Node>();
  private readonly spanIndex = new Map<string, Map<string, ts.Node>>();

  constructor(
    private readonly program: ts.Program,
    private parent?: TypeCheckerContext,
  ) {
    this.checker = program.getTypeChecker();
  }

  static create(options: TypeCheckerContextOptions): TypeCheckerContext {
    const compilerOptions: ts.CompilerOptions = {
      ...DEFAULT_COMPILER_OPTIONS,
      ...(options.compilerOptions ?? {}),
    };
    const sourceMap = options.inMemorySources
      ? toSourceMap(options.inMemorySources)
      : new Map<string, string>();
    const rootNames = options.rootNames.map((name) => normalizeFilePath(name));
    const host = ts.createCompilerHost(compilerOptions, true);

    const originalGetSourceFile = host.getSourceFile.bind(host);
    const originalReadFile = host.readFile.bind(host);
    const originalFileExists = host.fileExists.bind(host);
    const originalDirectoryExists = host.directoryExists?.bind(host);
    const sourceFileCache = new Map<string, ts.SourceFile>();

    // Pre-compute in-memory directories for fast directoryExists lookups.
    const inMemoryDirs = new Set<string>();
    for (const key of sourceMap.keys()) {
      let dir = path.dirname(key);
      while (dir !== path.dirname(dir)) {
        inMemoryDirs.add(dir);
        dir = path.dirname(dir);
      }
      inMemoryDirs.add(dir);
    }

    host.getCurrentDirectory = () => process.cwd();
    host.fileExists = (fileName) => {
      const normalized = normalizeFilePath(fileName);
      if (sourceMap.has(normalized)) return true;
      return originalFileExists(normalized);
    };
    host.readFile = (fileName) => {
      const normalized = normalizeFilePath(fileName);
      const inMemory = sourceMap.get(normalized);
      if (inMemory !== undefined) return inMemory;
      return originalReadFile(normalized);
    };
    if (originalDirectoryExists) {
      host.directoryExists = (dirName) => {
        const normalized = normalizeFilePath(dirName);
        if (inMemoryDirs.has(normalized)) return true;
        return originalDirectoryExists(normalized);
      };
    }
    host.getSourceFile = (
      fileName,
      languageVersion,
      onError,
      shouldCreateNew,
    ) => {
      const normalized = normalizeFilePath(fileName);
      const inMemory = sourceMap.get(normalized);
      if (inMemory !== undefined) {
        if (shouldCreateNew || !sourceFileCache.has(normalized)) {
          sourceFileCache.set(
            normalized,
            ts.createSourceFile(
              normalized,
              inMemory,
              languageVersion,
              true,
              normalized.endsWith(".tsx")
                ? ts.ScriptKind.TSX
                : normalized.endsWith(".jsx")
                  ? ts.ScriptKind.JSX
                  : normalized.endsWith(".js")
                    ? ts.ScriptKind.JS
                    : ts.ScriptKind.TS,
            ),
          );
        }
        return sourceFileCache.get(normalized) as ts.SourceFile;
      }
      if (!shouldCreateNew && isLibSourceFile(normalized)) {
        const cached = libSourceFileCache.get(normalized);
        if (cached) return cached;
        const fresh = originalGetSourceFile(
          fileName,
          languageVersion,
          onError,
          shouldCreateNew,
        );
        if (fresh) libSourceFileCache.set(normalized, fresh);
        return fresh;
      }
      return originalGetSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNew,
      );
    };

    const program = ts.createProgram({
      rootNames,
      options: compilerOptions,
      host,
      oldProgram: options.oldProgram,
    });
    return new TypeCheckerContext(program);
  }

  getProgram(): ts.Program {
    return this.program;
  }

  getTypeChecker(): ts.TypeChecker {
    return this.checker;
  }

  setParent(parent: TypeCheckerContext): void {
    this.parent = parent;
  }

  /**
   * Return a SourceFile that is registered with the TypeChecker.
   * If the file is not part of the original program, returns `undefined`;
   * callers must handle that case explicitly rather than creating an
   * uncheckered fallback.
   */
  getSourceFile(filePath: string): ts.SourceFile | undefined {
    const normalized = normalizeFilePath(filePath);
    return this.program.getSourceFile(normalized);
  }

  bindAstNode(astNode: ASTNode, tsNode: ts.Node): void {
    const sourceFile = tsNode.getSourceFile();
    if (!sourceFile) {
      // Synthetic or orphaned nodes lack a source file; skip bridging.
      return;
    }
    const filePath = normalizeFilePath(sourceFile.fileName);
    const start = tsNode.getStart(sourceFile, false);
    const end = tsNode.getEnd();
    const syntaxKind = tsNode.kind;
    const nodeId = buildNodeId(filePath, start, end, syntaxKind);
    astNode.tsNodeId = nodeId;
    astNode.sourceSpan = { filePath, start, end, syntaxKind };
    this.astToTsNode.set(astNode, tsNode);
    this.tsNodeById.set(nodeId, tsNode);
  }

  resolveTsNode(astNode: ASTNode): ts.Node | undefined {
    const mapped = this.astToTsNode.get(astNode);
    if (mapped) return mapped;
    const nodeId = astNode.tsNodeId;
    if (nodeId) {
      const fromId = this.tsNodeById.get(nodeId);
      if (fromId) {
        this.astToTsNode.set(astNode, fromId);
        return fromId;
      }
    }
    // Span lookup in the current program first to avoid cross-program node
    // pollution from the parent chain.
    const span = astNode.sourceSpan;
    if (span) {
      const sourceFile = this.program.getSourceFile(
        normalizeFilePath(span.filePath),
      );
      if (sourceFile) {
        const located = this.findNodeBySpan(sourceFile, span);
        if (located) {
          this.astToTsNode.set(astNode, located);
          if (nodeId) this.tsNodeById.set(nodeId, located);
          return located;
        }
      }
    }
    // Fallback to parent context when span lookup fails (e.g. nodes from
    // external files not present in the current program).
    if (this.parent) {
      const fromParent = this.parent.resolveTsNode(astNode);
      if (fromParent) {
        this.astToTsNode.set(astNode, fromParent);
        if (nodeId) this.tsNodeById.set(nodeId, fromParent);
        return fromParent;
      }
    }
    return undefined;
  }

  private findNodeBySpan(
    sourceFile: ts.SourceFile,
    span: { start: number; end: number; syntaxKind: number; filePath: string },
  ): ts.Node | undefined {
    const filePath = normalizeFilePath(sourceFile.fileName);
    let index = this.spanIndex.get(filePath);
    if (!index) {
      index = this.buildSpanIndex(sourceFile);
      this.spanIndex.set(filePath, index);
    }
    const key = `${span.start}:${span.end}:${span.syntaxKind}`;
    return index.get(key);
  }

  private buildSpanIndex(sourceFile: ts.SourceFile): Map<string, ts.Node> {
    const index = new Map<string, ts.Node>();
    const visit = (node: ts.Node): void => {
      const start = node.getStart(sourceFile, false);
      const end = node.getEnd();
      const key = `${start}:${end}:${node.kind}`;
      index.set(key, node);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return index;
  }
}

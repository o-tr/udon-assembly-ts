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
  baseUrl: packageRoot,
  paths: {
    "@ootr/udon-assembly-ts": ["src/index.ts"],
    "@ootr/udon-assembly-ts/*": ["src/*"],
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
}

export class TypeCheckerContext {
  private readonly checker: ts.TypeChecker;
  private readonly astToTsNode = new WeakMap<ASTNode, ts.Node>();
  private readonly tsNodeById = new Map<string, ts.Node>();
  private readonly sourceMap: Map<string, string>;

  constructor(
    private readonly program: ts.Program,
    sourceMap?: Map<string, string>,
  ) {
    this.checker = program.getTypeChecker();
    this.sourceMap = sourceMap ?? new Map();
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

    host.getCurrentDirectory = () =>
      compilerOptions.baseUrl
        ? path.resolve(compilerOptions.baseUrl)
        : process.cwd();
    host.fileExists = (fileName) => {
      const normalized = normalizeFilePath(fileName);
      if (sourceMap.has(normalized)) return true;
      return originalFileExists(fileName);
    };
    host.readFile = (fileName) => {
      const normalized = normalizeFilePath(fileName);
      const inMemory = sourceMap.get(normalized);
      if (inMemory !== undefined) return inMemory;
      return originalReadFile(fileName);
    };
    host.getSourceFile = (
      fileName,
      languageVersion,
      onError,
      shouldCreateNew,
    ) => {
      const normalized = normalizeFilePath(fileName);
      const inMemory = sourceMap.get(normalized);
      if (inMemory !== undefined) {
        return ts.createSourceFile(
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
        );
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
    });
    return new TypeCheckerContext(program, sourceMap);
  }

  getProgram(): ts.Program {
    return this.program;
  }

  getTypeChecker(): ts.TypeChecker {
    return this.checker;
  }

  getSourceFile(filePath: string): ts.SourceFile | undefined {
    const normalized = normalizeFilePath(filePath);
    const sourceFile = this.program.getSourceFile(normalized);
    if (sourceFile) return sourceFile;
    const sourceText = this.sourceMap.get(normalized);
    if (sourceText === undefined) return undefined;
    return ts.createSourceFile(
      normalized,
      sourceText,
      ts.ScriptTarget.ESNext,
      true,
      normalized.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : normalized.endsWith(".jsx")
          ? ts.ScriptKind.JSX
          : normalized.endsWith(".js")
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS,
    );
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
    const span = astNode.sourceSpan;
    if (!span) return undefined;
    const sourceFile = this.program.getSourceFile(
      normalizeFilePath(span.filePath),
    );
    if (!sourceFile) return undefined;
    const located = this.findNodeBySpan(sourceFile, span);
    if (!located) return undefined;
    this.astToTsNode.set(astNode, located);
    if (nodeId) this.tsNodeById.set(nodeId, located);
    return located;
  }

  private findNodeBySpan(
    sourceFile: ts.SourceFile,
    span: { start: number; end: number; syntaxKind: number; filePath: string },
  ): ts.Node | undefined {
    let found: ts.Node | undefined;
    const visit = (node: ts.Node): void => {
      if (found) return;
      const start = node.getStart(sourceFile, false);
      const end = node.getEnd();
      if (
        start === span.start &&
        end === span.end &&
        node.kind === span.syntaxKind
      ) {
        found = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  }
}

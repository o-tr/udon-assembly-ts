/**
 * Dependency resolver for batch transpiler
 */

import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

export type DependencyGraph = Map<string, Set<string>>;

export class DependencyResolver {
  private graph: DependencyGraph = new Map();
  private graphCache: Map<string, DependencyGraph> = new Map();
  private visiting: Set<string> = new Set();
  private compilerOptions: ts.CompilerOptions;
  private allowCircular: boolean;
  private sharedImportCache: Map<string, string[]> | null = null;
  private localImportCache: Map<string, string[]> = new Map();
  private resolveCache = new Map<string, string | null>();

  constructor(
    projectRoot: string = process.cwd(),
    options?: { allowCircular?: boolean },
  ) {
    this.compilerOptions = this.loadCompilerOptions(projectRoot);
    // Default to false to preserve previous behavior of throwing on
    // circular imports unless explicitly allowed.
    this.allowCircular = options?.allowCircular ?? false;
  }

  setImportCache(cache: Map<string, string[]>): void {
    this.sharedImportCache = cache;
  }

  buildGraph(entryPointPath: string): DependencyGraph {
    return this.buildGraphResolved(fs.realpathSync(entryPointPath));
  }

  clearCache(): void {
    this.graphCache.clear();
    this.localImportCache.clear();
    this.resolveCache.clear();
  }

  /**
   * Removes the cached graph for the given *entry point* path.
   * Only the graph keyed by this exact entry point is evicted.
   * Graphs of other entry points that transitively depend on this file
   * are NOT invalidated; call {@link clearCache} to evict everything.
   */
  invalidate(entryPointPath: string): void {
    let normalized: string;
    try {
      normalized = fs.realpathSync(entryPointPath);
    } catch {
      normalized = path.resolve(entryPointPath);
    }
    this.graphCache.delete(normalized);
    this.localImportCache.delete(normalized);
    this.resolveCache.clear();
  }

  getCompilationOrder(entryPoint: string): string[] {
    const normalized = fs.realpathSync(entryPoint);
    const graph = this.buildGraphResolved(normalized);
    return this.resolveDependencies(normalized, graph);
  }

  private buildGraphResolved(normalized: string): DependencyGraph {
    const cached = this.graphCache.get(normalized);
    if (cached) return cached;

    this.graph = new Map();
    this.visiting.clear();
    this.visitFile(normalized);
    const result: DependencyGraph = new Map();
    for (const [k, v] of this.graph) {
      result.set(k, new Set(v));
    }
    this.graphCache.set(normalized, result);
    return result;
  }

  private resolveDependencies(
    entryPoint: string,
    graph: DependencyGraph,
  ): string[] {
    const visited = new Set<string>();
    const order: string[] = [];

    const dfs = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const deps = graph.get(file);
      if (deps) {
        for (const dep of deps) dfs(dep);
      }
      order.push(file);
    };

    dfs(entryPoint);
    return order;
  }

  resolveImmediateDependencies(entryPointPath: string): string[] {
    const deps = new Set<string>();
    const moduleTexts = this.getModuleTexts(entryPointPath);

    for (const moduleText of moduleTexts) {
      const resolved = this.resolveModule(entryPointPath, moduleText);
      if (resolved && this.isResolvableSource(resolved)) {
        deps.add(resolved);
      }
    }

    return Array.from(deps);
  }

  private getModuleTexts(filePath: string): string[] {
    const local = this.localImportCache.get(filePath);
    if (local) return local;
    const shared = this.sharedImportCache?.get(filePath);
    if (shared) return shared;

    const sourceText = fs.readFileSync(filePath, "utf8");
    const moduleTexts: string[] = [];
    // Use ts.createScanner for token-level scanning: much faster than
    // ts.createSourceFile (no full AST) and safe from false positives
    // in string/template literals unlike regex-based approaches.
    const scanner = ts.createScanner(
      ts.ScriptTarget.ES2020,
      true,
      undefined,
      sourceText,
    );
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      if (
        token === ts.SyntaxKind.ImportKeyword ||
        token === ts.SyntaxKind.ExportKeyword
      ) {
        const isExport = token === ts.SyntaxKind.ExportKeyword;
        token = scanner.scan();
        // For export type { X } from "Y", skip past `type` keyword
        if (isExport && token === ts.SyntaxKind.TypeKeyword) {
          token = scanner.scan();
        }
        // For export, only handle re-export forms: export { X } from "Y" / export * from "Y"
        if (
          isExport &&
          token !== ts.SyntaxKind.OpenBraceToken &&
          token !== ts.SyntaxKind.AsteriskToken
        ) {
          token = scanner.scan();
          continue;
        }
        // Side-effect import: import "path"
        if (!isExport && token === ts.SyntaxKind.StringLiteral) {
          moduleTexts.push(scanner.getTokenValue());
          token = scanner.scan();
          continue;
        }
        // Skip tokens until `from` keyword at brace depth 0 followed by string literal
        let braceDepth = 0;
        while (
          token !== ts.SyntaxKind.EndOfFileToken &&
          token !== ts.SyntaxKind.SemicolonToken
        ) {
          if (token === ts.SyntaxKind.OpenBraceToken) braceDepth++;
          else if (token === ts.SyntaxKind.CloseBraceToken) braceDepth--;
          else if (token === ts.SyntaxKind.FromKeyword && braceDepth === 0) {
            token = scanner.scan();
            if (token === ts.SyntaxKind.StringLiteral) {
              moduleTexts.push(scanner.getTokenValue());
              break;
            }
            continue;
          }
          token = scanner.scan();
        }
      }
      token = scanner.scan();
    }
    this.localImportCache.set(filePath, moduleTexts);
    return moduleTexts;
  }

  private visitFile(filePath: string): void {
    if (this.graph.has(filePath)) return;
    if (this.visiting.has(filePath)) {
      if (this.allowCircular) {
        return;
      }
      throw new Error(`Circular dependency detected: ${filePath}`);
    }
    this.visiting.add(filePath);

    const moduleTexts = this.getModuleTexts(filePath);

    const deps = new Set<string>();
    this.graph.set(filePath, deps);
    for (const moduleText of moduleTexts) {
      const resolved = this.resolveModule(filePath, moduleText);
      if (resolved && this.isResolvableSource(resolved)) {
        deps.add(resolved);
        this.visitFile(resolved);
      }
    }
    this.visiting.delete(filePath);
  }

  private resolveModule(fromFile: string, modulePath: string): string | null {
    const cacheKey = `${fromFile}\0${modulePath}`;
    if (this.resolveCache.has(cacheKey)) {
      return this.resolveCache.get(cacheKey) ?? null;
    }
    const result = this.resolveModuleUncached(fromFile, modulePath);
    this.resolveCache.set(cacheKey, result);
    return result;
  }

  private resolveModuleUncached(
    fromFile: string,
    modulePath: string,
  ): string | null {
    if (!modulePath.startsWith(".")) {
      const resolved = ts.resolveModuleName(
        modulePath,
        fromFile,
        this.compilerOptions,
        ts.sys,
      );
      let resolvedFile = resolved.resolvedModule?.resolvedFileName;
      if (resolvedFile) {
        if (resolvedFile.endsWith(".d.ts")) {
          const tsCandidate = resolvedFile.replace(/\.d\.ts$/, ".ts");
          const tsxCandidate = resolvedFile.replace(/\.d\.ts$/, ".tsx");
          if (fs.existsSync(tsCandidate)) {
            resolvedFile = tsCandidate;
          } else if (fs.existsSync(tsxCandidate)) {
            resolvedFile = tsxCandidate;
          }
        }
        try {
          return fs.realpathSync(resolvedFile);
        } catch {
          return resolvedFile;
        }
      }
      return null;
    }

    const baseDir = path.dirname(fromFile);
    const resolvedBase = path.resolve(baseDir, modulePath);

    // Prefer explicit file candidates and index files before checking
    // the bare resolvedBase (which may be a directory). This avoids
    // returning directories unexpectedly and matches Node resolution.
    const candidates = [
      `${resolvedBase}.ts`,
      `${resolvedBase}.tsx`,
      `${resolvedBase}.d.ts`,
      path.join(resolvedBase, "index.ts"),
      path.join(resolvedBase, "index.tsx"),
      resolvedBase,
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) return fs.realpathSync(candidate);
        }
      } catch (_) {
        // ignore and continue
      }
    }

    return null;
  }

  private isResolvableSource(filePath: string): boolean {
    return (
      filePath.endsWith(".ts") ||
      filePath.endsWith(".tsx") ||
      filePath.endsWith(".d.ts")
    );
  }

  private loadCompilerOptions(searchFrom: string): ts.CompilerOptions {
    const configPath = ts.findConfigFile(
      searchFrom,
      ts.sys.fileExists,
      "tsconfig.json",
    );
    if (!configPath) {
      return {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2020,
      };
    }
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      return {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2020,
      };
    }
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath),
    );
    return parsed.options;
  }
}

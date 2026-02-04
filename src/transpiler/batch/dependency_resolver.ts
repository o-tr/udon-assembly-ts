/**
 * Dependency resolver for batch transpiler
 */

import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

export type DependencyGraph = Map<string, Set<string>>;

export class DependencyResolver {
  private graph: DependencyGraph = new Map();
  private visiting: Set<string> = new Set();

  buildGraph(entryPointPath: string): DependencyGraph {
    this.graph = new Map();
    this.visiting.clear();
    this.visitFile(entryPointPath);
    return this.graph;
  }

  resolveDependencies(entryPoint: string): string[] {
    const visited = new Set<string>();
    const order: string[] = [];

    const dfs = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const deps = this.graph.get(file);
      if (deps) {
        for (const dep of deps) dfs(dep);
      }
      order.push(file);
    };

    dfs(entryPoint);
    return order;
  }

  getCompilationOrder(entryPoint: string): string[] {
    return this.resolveDependencies(entryPoint);
  }

  private visitFile(filePath: string): void {
    if (this.graph.has(filePath)) return;
    if (this.visiting.has(filePath)) {
      throw new Error(`Circular dependency detected: ${filePath}`);
    }
    this.visiting.add(filePath);

    const sourceText = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.ES2020,
      true,
    );

    const deps = new Set<string>();
    this.graph.set(filePath, deps);
    for (const stmt of sourceFile.statements) {
      if (!ts.isImportDeclaration(stmt) || !stmt.moduleSpecifier) continue;
      const moduleText = stmt.moduleSpecifier.getText().replace(/['"]/g, "");
      if (!moduleText.startsWith(".")) continue;
      const resolved = this.resolveModule(filePath, moduleText);
      if (resolved && this.isTranspilableSource(resolved)) {
        deps.add(resolved);
        this.visitFile(resolved);
      }
    }
    this.visiting.delete(filePath);
  }

  private resolveModule(fromFile: string, modulePath: string): string | null {
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

  private isTranspilableSource(filePath: string): boolean {
    if (filePath.endsWith(".d.ts")) return false;
    return filePath.endsWith(".ts") || filePath.endsWith(".tsx");
  }
}

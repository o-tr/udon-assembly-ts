/**
 * File discovery for batch transpiler
 */

import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

export interface FileDiscoveryOptions {
  sourceDir: string;
  excludeDirs?: string[];
}

const DEFAULT_EXCLUDES = ["cli", "stubs", "test", "tests", "__tests__"];

export function discoverTypeScriptFiles(
  options: FileDiscoveryOptions,
): string[] {
  const exclude = new Set(options.excludeDirs ?? DEFAULT_EXCLUDES);
  const result: string[] = [];

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (exclude.has(entry.name)) continue;
        walk(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        result.push(entryPath);
      }
    }
  };

  walk(options.sourceDir);
  return result;
}

export function discoverEntryFilesUsingTS(options: {
  sourceDir: string;
  excludeDirs?: string[];
}): string[] {
  const exclude = new Set(options.excludeDirs ?? DEFAULT_EXCLUDES);
  const result: string[] = [];

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (exclude.has(entry.name)) continue;
        walk(entryPath);
        continue;
      }
      if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ) {
        try {
          const sourceText = fs.readFileSync(entryPath, "utf8");
          const src = ts.createSourceFile(
            entryPath,
            sourceText,
            ts.ScriptTarget.ES2020,
            true,
          );
          let isEntry = false;
          ts.forEachChild(src, (node) => {
            if (!ts.isClassDeclaration(node)) return;
            const decorators = ts.canHaveDecorators(node)
              ? (ts.getDecorators(node) ?? [])
              : [];
            for (const dec of decorators) {
              const expr = dec.expression as ts.Expression;
              let name = "";
              if (ts.isCallExpression(expr)) {
                const e = expr.expression;
                if (ts.isIdentifier(e)) name = e.escapedText?.toString() ?? "";
              } else if (ts.isIdentifier(expr)) {
                name = expr.escapedText?.toString() ?? "";
              }
              if (name === "UdonBehaviour") {
                isEntry = true;
                break;
              }
            }
          });
          if (isEntry) result.push(entryPath);
        } catch (_) {
          // ignore parse errors in discovery
        }
      }
    }
  };

  walk(options.sourceDir);
  return result;
}

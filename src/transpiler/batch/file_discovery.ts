/**
 * File discovery for batch transpiler
 */

import fs from "node:fs";
import path from "node:path";

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

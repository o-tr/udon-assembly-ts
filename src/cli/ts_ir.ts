#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BatchTranspiler,
  TypeScriptToUdonTranspiler,
} from "../transpiler/index.js";

type Command = "emit" | "run";

type Options = {
  readonly command: Command;
  readonly input: string;
  readonly output: string;
  readonly filters: string[];
  readonly optimize: boolean;
};

function parseArgs(argv: readonly string[]): Options {
  const command = (argv[0] ?? "emit") as Command;
  if (command !== "emit" && command !== "run") {
    throw new Error(`Unknown ts-ir command: ${command}`);
  }

  let input = "tests/ts_ir/fixtures";
  let output = "generated/ts-ir";
  let optimize = false;
  const filters: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-i" || arg === "--input") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for -i/--input");
      input = value;
      i += 1;
      continue;
    }
    if (arg === "-o" || arg === "--output") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for -o/--output");
      output = value;
      i += 1;
      continue;
    }
    if (arg === "--filter") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --filter");
      filters.push(...value.split(",").filter((part) => part.length > 0));
      i += 1;
      continue;
    }
    if (arg === "--optimize") {
      optimize = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return { command, input, output, filters, optimize };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "emit") {
    emitArtifacts(options);
    return;
  }
  await runArtifacts(options);
}

function emitArtifacts(options: Options): void {
  const input = path.resolve(options.input);
  const output = path.resolve(options.output);
  const casesDir = path.join(output, "cases");
  const runtimeDir = path.join(output, "runtime");
  fs.mkdirSync(casesDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, "index.ts"),
    'export * from "../../../src/transpiler/ts_ir/runtime/index.js";\n',
  );

  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    emitDirectoryArtifacts(input, casesDir, options);
    return;
  }

  const transpiler = new TypeScriptToUdonTranspiler();
  for (const sourcePath of [input]) {
    const source = fs.readFileSync(sourcePath, "utf8");
    const caseName = path.basename(sourcePath, ".ts");
    const result = transpiler.transpile(source, {
      emitTsIr: true,
      optimize: options.optimize,
      silent: true,
      sourceFilePath: sourcePath,
    });
    if (!result.tsIr) {
      throw new Error(`TS IR was not emitted for ${sourcePath}`);
    }
    fs.writeFileSync(path.join(casesDir, `${caseName}.ir.ts`), result.tsIr);
    fs.writeFileSync(
      path.join(casesDir, `${caseName}.test.ts`),
      generatedTestSource(caseName),
    );
  }
}

function emitDirectoryArtifacts(
  input: string,
  casesDir: string,
  options: Options,
): void {
  const result = new BatchTranspiler().transpile({
    sourceDir: input,
    outputDir: casesDir,
    outputExtension: "ir.ts",
    optimize: options.optimize,
    includeExternalDependencies: true,
    useStringBuilder: false,
    useOutputCache: false,
    silent: true,
    entryPointNames: [...options.filters],
  });
  for (const output of result.outputs) {
    fs.writeFileSync(
      path.join(
        casesDir,
        `${path.basename(output.outputPath, ".ir.ts")}.test.ts`,
      ),
      generatedTestSource(output.className),
    );
  }
}

async function runArtifacts(options: Options): Promise<void> {
  const casesDir = path.resolve(options.output, "cases");
  for (const file of fs.readdirSync(casesDir)) {
    if (!file.endsWith(".ir.ts")) continue;
    const mod = (await import(
      pathToFileURL(path.join(casesDir, file)).href
    )) as {
      runTsIr: () => unknown;
    };
    mod.runTsIr();
  }
}

function generatedTestSource(caseName: string): string {
  return `import { describe, expect, it } from "vitest";
import { runTsIr } from "./${caseName}.ir.js";

describe("TS IR generated case: ${caseName}", () => {
  it("executes without an unexpected runtime error", () => {
    expect(() => runTsIr()).not.toThrow();
  });
});
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

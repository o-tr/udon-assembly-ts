#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TypeScriptToUdonTranspiler } from "../transpiler/index.js";

type Command = "emit" | "run";

type Options = {
  readonly command: Command;
  readonly input: string;
  readonly output: string;
};

function parseArgs(argv: readonly string[]): Options {
  const command = (argv[0] ?? "emit") as Command;
  if (command !== "emit" && command !== "run") {
    throw new Error(`Unknown ts-ir command: ${command}`);
  }

  let input = "tests/ts_ir/fixtures";
  let output = "generated/ts-ir";
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
    throw new Error(`Unknown option: ${arg}`);
  }
  return { command, input, output };
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

  const sources = collectSources(input);
  const transpiler = new TypeScriptToUdonTranspiler();
  for (const sourcePath of sources) {
    const source = fs.readFileSync(sourcePath, "utf8");
    const caseName = path.basename(sourcePath, ".ts");
    const result = transpiler.transpile(source, {
      emitTsIr: true,
      optimize: false,
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

function collectSources(input: string): string[] {
  const stat = fs.statSync(input);
  if (stat.isFile()) return [input];
  return fs
    .readdirSync(input)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => path.join(input, file))
    .sort();
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

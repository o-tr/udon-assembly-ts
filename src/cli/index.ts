#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import type { BatchTranspilerOptions } from "../transpiler/batch/batch_transpiler.js";
import { BatchTranspiler } from "../transpiler/index.js";

interface Options {
  inputs: string[];
  output: string;
  verbose: boolean;
  optimize: boolean;
  reflect: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    inputs: [],
    output: "output/transpiler",
    verbose: false,
    optimize: true,
    reflect: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-i" || arg === "--input") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for -i/--input");
      opts.inputs.push(value);
      i += 1;
      continue;
    }
    if (arg === "-o" || arg === "--output") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for -o/--output");
      opts.output = value;
      i += 1;
      continue;
    }
    if (arg === "-v" || arg === "--verbose") {
      opts.verbose = true;
      continue;
    }
    if (arg === "--no-optimize") {
      opts.optimize = false;
      continue;
    }
    if (arg === "--reflect") {
      opts.reflect = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (!arg.startsWith("-")) {
      opts.inputs.push(arg);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return opts;
}

function printHelp(): void {
  console.log(`Usage: udon-assembly-ts -i <dir> [options]

Options:
  -i, --input <dir>     Input directory (repeatable)
  -o, --output <dir>    Output directory (default: output/transpiler)
  -v, --verbose         Verbose logging
  --no-optimize         Disable TAC optimizer
  --reflect             Append reflection metadata to data section
  -h, --help            Show this help

Examples:
  udon-assembly-ts -i src
  udon-assembly-ts -i src/core -i src/vrc -o out
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.inputs.length === 0) {
    printHelp();
    process.exit(1);
  }

  const transpiler = new BatchTranspiler();

  for (const input of opts.inputs) {
    const resolvedInput = path.resolve(input);
    if (!fs.existsSync(resolvedInput)) {
      console.error(`Input not found: ${resolvedInput}`);
      process.exitCode = 1;
      continue;
    }
    if (!fs.statSync(resolvedInput).isDirectory()) {
      console.error(`Input must be a directory: ${resolvedInput}`);
      process.exitCode = 1;
      continue;
    }

    const outBase = path.resolve(opts.output);
    const outDir = path.join(outBase, path.basename(resolvedInput));
    fs.mkdirSync(outDir, { recursive: true });

    if (opts.verbose) {
      console.log(`Transpiling ${resolvedInput} -> ${outDir}`);
    }

    const options: BatchTranspilerOptions = {
      sourceDir: resolvedInput,
      outputDir: outDir,
      optimize: opts.optimize,
      reflect: opts.reflect,
      verbose: opts.verbose,
      excludeDirs: [],
    };

    try {
      const result = transpiler.transpile(options);
      if (opts.verbose) {
        for (const o of result.outputs) {
          console.log(`Generated: ${o.outputPath}`);
        }
      }
    } catch (err) {
      console.error(`Error transpiling ${input}:`);
      if (err instanceof Error) console.error(err.message);
      else console.error(err);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

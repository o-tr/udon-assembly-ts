import { defineConfig } from "tsup";

const base = {
  format: ["esm"],
  target: "es2022",
  platform: "node",
  splitting: false,
  sourcemap: true,
  outDir: "dist",
  bundle: false,
} as const;

export default defineConfig([
  {
    ...base,
    entry: [
      "src/index.ts",
      "src/transpiler/**/*.ts",
      "src/stubs/*.ts",
    ],
    dts: true,
    clean: true,
  },
  {
    ...base,
    entry: ["src/cli/index.ts"],
    dts: false,
    clean: false,
    outDir: "dist/cli",
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);

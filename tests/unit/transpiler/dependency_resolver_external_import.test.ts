import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DependencyResolver } from "../../../src/transpiler/batch/dependency_resolver";

describe("DependencyResolver external imports", () => {
  it("resolves node_modules .d.ts imports", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "udon-deps-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      const nodeModulesDir = path.join(tmpDir, "node_modules", "external-lib");
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(nodeModulesDir, { recursive: true });

      fs.writeFileSync(
        path.join(tmpDir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              moduleResolution: "NodeNext",
              target: "ES2020",
            },
          },
          null,
          2,
        ),
      );

      fs.writeFileSync(
        path.join(srcDir, "index.ts"),
        `import { ExternalThing } from "external-lib";\nexport const value = ExternalThing;\n`,
      );

      fs.writeFileSync(
        path.join(nodeModulesDir, "package.json"),
        JSON.stringify({ name: "external-lib", types: "index.d.ts" }),
      );
      fs.writeFileSync(
        path.join(nodeModulesDir, "index.d.ts"),
        "export class ExternalThing {}\n",
      );

      const entry = path.join(srcDir, "index.ts");
      const resolver = new DependencyResolver(tmpDir);
      const graph = resolver.buildGraph(entry);
      const deps = graph.get(entry);

      expect(deps).toBeDefined();
      const resolved = deps ? Array.from(deps) : [];
      expect(
        resolved.some((dep) =>
          dep.endsWith(path.join("node_modules", "external-lib", "index.d.ts")),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

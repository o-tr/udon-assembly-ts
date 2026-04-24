/**
 * Regression test for the cross-module inline-interface wrap-as-Object bug.
 *
 * Scenario: a type-aliased or declared interface is used as a value type in a
 * Map across multiple files (e.g. `type IAlias = {...}` declared in `types.ts`,
 * used as `Map<string, IAlias>` in `Registry.ts`, implemented as an inline
 * class in `ImplA.ts`). Before the fix, the WRITE site (`map.set(key, impl)`)
 * resolved the parameter's type via the TypeChecker's anonymous-object path,
 * produced an `__anon_<digest>` InterfaceTypeSymbol name, missed the
 * `interfaceClassIdMap` lookup (which is keyed by canonical alias name), and
 * emitted `DataToken.__ctor__SystemObject__` — boxing the Int32 handle as an
 * Object. The subsequent READ (`map.get`) expected an Int32 handle and halted
 * the VM at `DataToken.__get_Int__SystemInt32`.
 *
 * Fix: preserve the canonical alias name in `type_checker_type_resolver.ts`
 * at step 7e (TypeAlias recursion) and step 8 (direct anonymous entry) so the
 * WRITE-side operand type carries the same alias name the READ side sees.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchTranspiler } from "../../../src/transpiler/batch/batch_transpiler";

const createdDirs: string[] = [];

function writeFixture(decl: "type" | "interface"): {
  sourceDir: string;
  outputDir: string;
} {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `cross-module-iface-${decl}-`),
  );
  createdDirs.push(tempDir);
  const sourceDir = path.join(tempDir, "src");
  const outputDir = path.join(tempDir, "out");
  fs.mkdirSync(sourceDir, { recursive: true });

  const alias =
    decl === "type"
      ? `export type IAlias = { id: number; run(): number };`
      : `export interface IAlias { id: number; run(): number; }`;

  // A second interface with NO inline implementor — negative control for
  // guard selectivity. wraps on Map<string, IOther> must still fall through
  // to the SystemObject ctor, proving the alias preservation does not
  // over-broaden the inline-handle guard.
  const other =
    decl === "type"
      ? `export type IOther = { tag: string };`
      : `export interface IOther { tag: string; }`;

  fs.writeFileSync(
    path.join(sourceDir, "types.ts"),
    `${alias}\n${other}\n`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(sourceDir, "ImplA.ts"),
    `
import type { IAlias } from "./types";

export class ImplA implements IAlias {
  id: number = 0;
  run(): number {
    return this.id + 1;
  }
}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(sourceDir, "Registry.ts"),
    `
import type { IAlias, IOther } from "./types";

export class Registry {
  private map: Map<string, IAlias> = new Map<string, IAlias>();
  private others: Map<string, IOther> = new Map<string, IOther>();

  register(name: string, item: IAlias): void {
    this.map.set(name, item);
  }

  registerOther(name: string, other: IOther): void {
    this.others.set(name, other);
  }

  lookup(name: string): IAlias | null {
    return this.map.get(name);
  }
}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(sourceDir, "Entry.ts"),
    `
import { ImplA } from "./ImplA";
import { Registry } from "./Registry";
import type { IOther } from "./types";

@UdonBehaviour()
class Entry extends UdonSharpBehaviour {
  @EntryPoint()
  _start(): void {
    const registry = new Registry();
    const impl = new ImplA();
    impl.id = 7;
    registry.register("first", impl);
    const readBack = registry.lookup("first");
    if (readBack !== null) {
      Debug.Log(readBack.run().toString());
    }
    const other: IOther = { tag: "t" };
    registry.registerOther("tag", other);
  }
}
`,
    "utf8",
  );

  return { sourceDir, outputDir };
}

function buildFixtureUasm(decl: "type" | "interface"): string {
  const { sourceDir, outputDir } = writeFixture(decl);
  new BatchTranspiler().transpile({
    sourceDir,
    outputDir,
    excludeDirs: [],
    outputExtension: "uasm",
  });
  const files = fs.readdirSync(outputDir).filter((f) => f.endsWith(".uasm"));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(outputDir, files[0]), "utf8");
}

afterAll(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cross-module inline-interface Map<K, IAlias>.set wrap", () => {
  for (const decl of ["type", "interface"] as const) {
    describe(`declared as \`${decl} IAlias\``, () => {
      let uasm = "";
      let lines: string[] = [];

      beforeAll(() => {
        uasm = buildFixtureUasm(decl);
        lines = uasm.split("\n");
      });

      it(`WRITE site emits DataToken ctor(Int32), not ctor(Object)`, () => {
        // The DataToken(Int32) ctor is the target overload — the fix flips
        // the previously-emitted SystemObject ctor to this one for the
        // Registry.register wrap of the inline IAlias handle.
        expect(uasm).toMatch(
          /DataToken\.__ctor__SystemInt32__VRCSDK3DataDataToken/,
        );
      });

      it(`WRITE site handle is %SystemInt32, flowing into the ctor`, () => {
        // Find the Int32 DataToken ctor extern declaration and its alias.
        const externDecl = lines.find((l) =>
          l.includes("DataToken.__ctor__SystemInt32__VRCSDK3DataDataToken"),
        );
        expect(externDecl).toBeDefined();
        if (!externDecl) return;
        const externAlias = externDecl.trim().split(":")[0].trim();

        // Find the EXTERN call for this alias.
        const callIdx = lines.findIndex(
          (l) =>
            l.includes("EXTERN,") && l.trim().split(/,\s*/)[1] === externAlias,
        );
        expect(callIdx).toBeGreaterThan(-1);

        // The Int32 ctor's signature is `PUSH <int32-handle>; PUSH <token-
        // dest>; EXTERN ctor`. Scan backwards for the two nearest PUSH lines
        // — tolerant of any blank/label/comment lines a future codegen pass
        // might interleave — and assert at least one operand is declared as
        // %SystemInt32.
        const pushOperands: string[] = [];
        for (let i = callIdx - 1; i >= 0 && pushOperands.length < 2; i--) {
          const trimmed = lines[i]?.trim() ?? "";
          if (trimmed.startsWith("PUSH,")) {
            pushOperands.push(trimmed.replace(/^PUSH,\s+/, "").trim());
          }
        }
        expect(pushOperands.length).toBe(2);

        const anyIsInt32 = pushOperands.some((name) => {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const declPattern = new RegExp(`^\\s*${escaped}:\\s*%System\\S+`);
          const operandDecl = lines.find((l) => declPattern.test(l));
          return operandDecl?.includes("%SystemInt32");
        });
        expect(anyIsInt32).toBe(true);
      });

      it(`negative control: Map<string, IOther>.set still uses ctor(Object)`, () => {
        // IOther has no inline implementor, so it is NOT in
        // interfaceClassIdMap; its wrap site must remain a SystemObject ctor.
        // If the alias-name preservation over-broadened the guard, this
        // assertion would fire (we'd see _only_ Int32 ctors).
        expect(uasm).toMatch(
          /DataToken\.__ctor__SystemObject__VRCSDK3DataDataToken/,
        );
      });

      it(`no \`__anon_\` names leak into the generated UASM`, () => {
        // With the fix, any named type alias or declared interface should
        // surface in the UASM under its canonical name — never as
        // `__anon_<digest>`. Object literals without alias context remain
        // anonymous (out of scope for this fix), but the fixture does not
        // contain any such literal in a position that would name a temp.
        expect(uasm).not.toMatch(/__anon_/);
      });
    });
  }
});

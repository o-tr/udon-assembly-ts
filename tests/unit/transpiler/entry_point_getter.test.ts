/**
 * Regression tests for getter handling on @UdonBehaviour (entry-point)
 * classes. The inline-class getter fix also needs to work when the
 * receiver is the entry-point class itself: reading `this.foo` where
 * `foo` is a getter must inline the body rather than returning a phantom
 * entry-point slot that was never initialized.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("entry-point class getter inlining", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("inlines a getter body that reads a backing field on @UdonBehaviour", () => {
    const source = `
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private _hp: number = 42;
        get hp(): number {
          return this._hp;
        }
        Start(): void {
          Debug.Log(this.hp);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    // The inlined return must read the backing field `_hp`, not a phantom
    // `hp` slot. `entryPointPropName` uses the raw property name, so the
    // backing field appears as `_hp` in TAC.
    expect(result.tac).toMatch(/__inline_ret_\d+ = _hp\b/);
    expect(result.tac).not.toMatch(/__inline_ret_\d+ = hp\b/);
  });

  it("does not emit EntryPointGetterUnsupported for a well-formed getter", () => {
    const source = `
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private _value: number = 1;
        get value(): number {
          return this._value;
        }
        Start(): void {
          Debug.Log(this.value);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    const diagnostics = result.diagnostics ?? [];
    expect(
      diagnostics.some((d) => d.code === "EntryPointGetterUnsupported"),
    ).toBe(false);
  });

  it("short-circuits compound assignment to a getter-only property", () => {
    // `this.hp += 5` where `hp` is a getter-only property. TypeScript
    // would reject this in a strict project, but transpiler-synthesized
    // paths or loose TS could reach it. The expected outcome: no silent
    // write to a phantom slot; a WriteToGetter diagnostic is raised.
    const source = `
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        private _hp: number = 10;
        get hp(): number {
          return this._hp;
        }
        Start(): void {
          // @ts-ignore: write to getter-only intentionally
          this.hp += 5;
          Debug.Log(this._hp);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    const diagnostics = result.diagnostics ?? [];
    expect(diagnostics.some((d) => d.code === "WriteToGetter")).toBe(true);
    // The backing field `_hp` must not appear as the target of a TAC copy
    // produced by the compound-assignment fast-path for a getter result.
    // (We rely on WriteToGetter short-circuit to drop the write.)
    expect(result.tac).not.toMatch(/_hp\s*=\s*_hp\s*\+/);
  });

  it("emits SetterBodyUnsupported when a setter has a non-empty body", () => {
    const source = `
      class Wrapper {
        private _inner: number = 0;
        get inner(): number {
          return this._inner;
        }
        set inner(v: number) {
          this._inner = v;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const w = new Wrapper();
          w.inner = 42;
          Debug.Log(w.inner);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    const diagnostics = result.diagnostics ?? [];
    expect(diagnostics.some((d) => d.code === "SetterBodyUnsupported")).toBe(
      true,
    );
  });

  it("warns when an inline-class getter would recurse into itself", () => {
    // Recursive getter on an inline (non-@UdonBehaviour) class. Every
    // read-path fallback silently returns undefined for a getter, so
    // without the diagnostic inside evaluateInlineGetter the user would
    // get no signal at all. Regression for the inline-class side of
    // EntryPointGetterUnsupported.
    const source = `
      class Box {
        get value(): number {
          return this.value;
        }
      }
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        Start(): void {
          const b = new Box();
          Debug.Log(b.value);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    const diagnostics = result.diagnostics ?? [];
    expect(
      diagnostics.some((d) => d.code === "EntryPointGetterUnsupported"),
    ).toBe(true);
  });

  it("warns when an entry-point getter would recurse into itself", () => {
    const source = `
      @UdonBehaviour()
      class Main extends UdonSharpBehaviour {
        get value(): number {
          return this.value;
        }
        Start(): void {
          Debug.Log(this.value);
        }
      }
    `;
    const result = new TypeScriptToUdonTranspiler().transpile(source, {
      silent: true,
    });
    const diagnostics = result.diagnostics ?? [];
    expect(
      diagnostics.some((d) => d.code === "EntryPointGetterUnsupported"),
    ).toBe(true);
  });
});

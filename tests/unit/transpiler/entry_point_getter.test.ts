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

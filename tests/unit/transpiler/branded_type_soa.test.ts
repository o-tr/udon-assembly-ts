import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

describe("branded primitive type SoA DataToken fix", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("UdonInt field resolves to Int32 type (not Object)", () => {
    const source = `
      type UdonInt = number & { readonly __brand: "UdonInt" };

      class Counter {
        count: UdonInt;
        constructor(count: UdonInt) {
          this.count = count;
        }
      }

      @UdonBehaviour
      class TestClass {
        start(): void {
          let c = new Counter(0 as UdonInt);
          let k: UdonInt = c.count;
        }
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source, { optimize: false });

    expect(result.uasm).toContain("__inst_Counter_0_count: %SystemInt32");
    expect(result.uasm).toContain("k: %SystemInt32");
  });

  it("UdonFloat field resolves to Single type (not Object)", () => {
    const source = `
      type UdonFloat = number & { readonly __brand: "UdonFloat" };

      class Measurement {
        value: UdonFloat;
        constructor(value: UdonFloat) {
          this.value = value;
        }
      }

      @UdonBehaviour
      class TestClass {
        start(): void {
          let m = new Measurement(1.0 as UdonFloat);
          let v: UdonFloat = m.value;
        }
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source, { optimize: false });

    expect(result.uasm).toContain("__inst_Measurement_0_value: %SystemSingle");
    expect(result.uasm).toContain("v: %SystemSingle");
  });

  it("UdonByte field resolves to Byte type (not Object)", () => {
    const source = `
      type UdonByte = number & { readonly __brand: "UdonByte" };

      class Pixel {
        brightness: UdonByte;
        constructor(brightness: UdonByte) {
          this.brightness = brightness;
        }
      }

      @UdonBehaviour
      class TestClass {
        start(): void {
          let p = new Pixel(128 as UdonByte);
          let b: UdonByte = p.brightness;
        }
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source, { optimize: false });

    expect(result.uasm).toContain("__inst_Pixel_0_brightness: %SystemByte");
    expect(result.uasm).toContain("b: %SystemByte");
  });

  it("UdonInt field SoA wrap/unwrap uses correct DataToken accessors", () => {
    const source = `
      type UdonInt = number & { readonly __brand: "UdonInt" };

      class Tile {
        kind: UdonInt;
        code: UdonInt;
        isRed: boolean;
        constructor(kind: UdonInt, code: UdonInt, isRed: boolean) {
          this.kind = kind;
          this.code = code;
          this.isRed = isRed;
        }
      }

      @UdonBehaviour
      class TestClass {
        tiles: Tile[] = [];
        start(): void {
          this.tiles = [];
          for (let i = 0; i < 3; i += 1) {
            let t = new Tile(i as UdonInt, (i * 2) as UdonInt, false);
            this.tiles.push(t);
          }
          let first: Tile = this.tiles[0];
          let k: UdonInt = first.kind;
          let c: UdonInt = first.code;
        }
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source, { optimize: false });

    expect(result.uasm).toContain("VRCSDK3DataDataToken.__ctor__SystemInt32");
    expect(result.uasm).not.toContain(
      "VRCSDK3DataDataToken.__ctor__SystemObject",
    );
    expect(result.uasm).toContain(
      "VRCSDK3DataDataToken.__get_Int__SystemInt32",
    );
  });

  it("UdonLong field resolves to Int64 type (not Object)", () => {
    const source = `
      type UdonLong = bigint & { readonly __brand: "UdonLong" };

      class BigNumber {
        value: UdonLong;
        constructor(value: UdonLong) {
          this.value = value;
        }
      }

      @UdonBehaviour
      class TestClass {
        start(): void {
          let b = new BigNumber(0n as UdonLong);
          let v: UdonLong = b.value;
        }
      }
    `;
    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source, { optimize: false });

    expect(result.uasm).toContain("__inst_BigNumber_0_value: %SystemInt64");
    expect(result.uasm).toContain("v: %SystemInt64");
  });
});

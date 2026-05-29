import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ExternTypes,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  CallInstruction,
  ConditionalJumpInstruction,
  LabelInstruction,
  MethodCallInstruction,
  PropertyGetInstruction,
  ReturnInstruction,
  UnconditionalJumpInstruction,
} from "../../../src/transpiler/ir/tac_instruction.js";
import {
  createConstant,
  createLabel,
  createTemporary,
  createVariable,
} from "../../../src/transpiler/ir/tac_operand.js";
import { emitTsIr } from "../../../src/transpiler/ts_ir/index.js";

describe("TS IR emitter", () => {
  it("emits deterministic switch-based TS IR for a minimal TAC program", () => {
    const a = createVariable("a", PrimitiveTypes.int32);
    const b = createVariable("b", PrimitiveTypes.int32);
    const sum = createTemporary(0, PrimitiveTypes.int32);
    const done = createLabel("done");
    const result = emitTsIr([
      new AssignmentInstruction(a, createConstant(1, PrimitiveTypes.int32)),
      new AssignmentInstruction(b, createConstant(2, PrimitiveTypes.int32)),
      new BinaryOpInstruction(sum, a, "+", b),
      new ConditionalJumpInstruction(sum, done),
      new UnconditionalJumpInstruction(done),
      new LabelInstruction(done),
      new ReturnInstruction(sum, "returnValue"),
    ]);

    expect(result.labels).toEqual({ done: 5 });
    expect(result.heapSlots).toMatchObject({
      a: "number | undefined",
      b: "number | undefined",
      __t0: "number | undefined",
    });
    expect(result.code).toContain("while (true)");
    expect(result.code).toContain("switch (pc)");
    expect(result.code).toContain("// TAC 2: t0 = a + b");
    expect(result.code).toContain("runtime.binaryOp");
  });

  it("emits null DataList.Count as a runtime-checked property read", () => {
    const list = createVariable("list", ExternTypes.dataList);
    const count = createVariable("count", PrimitiveTypes.int32);
    const result = emitTsIr([
      new AssignmentInstruction(
        list,
        createConstant(null, ExternTypes.dataList),
      ),
      new PropertyGetInstruction(count, list, "Count"),
    ]);

    expect(result.code).toContain("runtime.getProperty");
    expect(result.code).toContain("TAC 1: count = list.Count");
    expect(result.heapSlots.list).toBe(
      "runtime.DataList<unknown> | null | undefined",
    );
  });

  it("exposes TS IR through the main transpiler without changing UASM output", () => {
    const source = `
      class Demo {
        Start(): void {
          const x: int = 1;
          const y: int = x + 2;
        }
      }
    `;
    const normal = new TypeScriptToUdonTranspiler().transpile(source, {
      optimize: false,
      silent: true,
    });
    const withTsIr = new TypeScriptToUdonTranspiler().transpile(source, {
      emitTsIr: true,
      optimize: false,
      silent: true,
    });

    expect(withTsIr.tsIr).toContain("export function runTsIr");
    expect(withTsIr.uasm).toBe(normal.uasm);
  });

  it("emits in-memory data-mode TS IR that runs through the runtime", async () => {
    const dict = createVariable("dict", ExternTypes.dataDictionary);
    const key = createVariable("key", ExternTypes.dataToken);
    const value = createVariable("value", ExternTypes.dataToken);
    const keys = createVariable("keys", ExternTypes.dataList);
    const count = createVariable("count", PrimitiveTypes.int32);

    const result = emitTsIr(
      [
        new CallInstruction(
          dict,
          "VRCSDK3DataDataDictionary.__ctor____VRCSDK3DataDataDictionary",
          [],
        ),
        new CallInstruction(
          key,
          "VRCSDK3DataDataToken.__ctor__SystemString__VRCSDK3DataDataToken",
          [createConstant("x", PrimitiveTypes.string)],
        ),
        new CallInstruction(
          value,
          "VRCSDK3DataDataToken.__op_Implicit__SystemDouble__VRCSDK3DataDataToken",
          [createConstant(7, PrimitiveTypes.double)],
        ),
        new MethodCallInstruction(undefined, dict, "SetValue", [key, value]),
        new MethodCallInstruction(keys, dict, "GetKeys", []),
        new PropertyGetInstruction(count, keys, "Count"),
        new ReturnInstruction(count, "returnValue"),
      ],
      {
        mode: "data",
        moduleImportPath: pathToFileURL(
          path.resolve("src/transpiler/ts_ir/runtime/index.ts"),
        ).href,
      },
    );

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-ir-emit-"));
    try {
      const modulePath = path.join(tempDir, "program.mjs");
      fs.writeFileSync(modulePath, result.code);
      const mod = (await import(pathToFileURL(modulePath).href)) as {
        runTsIr: () => { heap: Record<string, unknown> };
      };

      expect(mod.runTsIr().heap.returnValue).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps linear-mode fallback binary operations three-argument", () => {
    const left = createVariable("left", PrimitiveTypes.int32);
    const right = createVariable("right", PrimitiveTypes.int32);
    const value = createTemporary(0, PrimitiveTypes.int32);
    const result = emitTsIr(
      [
        new AssignmentInstruction(
          left,
          createConstant(5, PrimitiveTypes.int32),
        ),
        new AssignmentInstruction(
          right,
          createConstant(3, PrimitiveTypes.int32),
        ),
        new BinaryOpInstruction(value, left, "|", right),
        new ReturnInstruction(value, "returnValue"),
      ],
      { mode: "linear", compact: true },
    );

    expect(result.code).toContain('runtime.binaryOp(left, "|", right)');
  });
});

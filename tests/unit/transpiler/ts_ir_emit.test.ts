import { describe, expect, it } from "vitest";
import {
  ExternTypes,
  PrimitiveTypes,
} from "../../../src/transpiler/frontend/type_symbols.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
import {
  AssignmentInstruction,
  BinaryOpInstruction,
  ConditionalJumpInstruction,
  LabelInstruction,
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
});

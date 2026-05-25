import type { TypeSymbol } from "../frontend/type_symbols.js";
import { UdonType } from "../frontend/types.js";
import {
  type AssignmentInstruction,
  type BinaryOpInstruction,
  type CallInstruction,
  type CastInstruction,
  type ConditionalJumpInstruction,
  type CopyInstruction,
  type LabelInstruction,
  type MethodCallInstruction,
  type PropertyGetInstruction,
  type PropertySetInstruction,
  type ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  type UnconditionalJumpInstruction,
} from "../ir/tac_instruction.js";
import {
  type ConstantOperand,
  operandToString,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand,
} from "../ir/tac_operand.js";

export interface TsIrEmitOptions {
  moduleImportPath?: string;
  functionName?: string;
}

export interface TsIrEmitResult {
  code: string;
  labels: Record<string, number>;
  heapSlots: Record<string, string>;
}

type SlotInfo = {
  readonly name: string;
  readonly type: string;
};

export function emitTsIr(
  instructions: readonly TACInstruction[],
  options: TsIrEmitOptions = {},
): TsIrEmitResult {
  return new TsIrEmitter(instructions, options).emit();
}

class TsIrEmitter {
  private readonly labels = new Map<string, number>();
  private readonly slots = new Map<string, SlotInfo>();
  private readonly moduleImportPath: string;
  private readonly functionName: string;

  constructor(
    private readonly instructions: readonly TACInstruction[],
    options: TsIrEmitOptions,
  ) {
    this.moduleImportPath = options.moduleImportPath ?? "../runtime/index.js";
    this.functionName = options.functionName ?? "runTsIr";
  }

  emit(): TsIrEmitResult {
    this.collectLabelsAndSlots();
    const lines: string[] = [
      `import * as runtime from ${JSON.stringify(this.moduleImportPath)};`,
      "",
      "export type Heap = {",
      ...Array.from(
        this.slots.values(),
        (slot) => `  ${JSON.stringify(slot.name)}: ${slot.type};`,
      ),
      "};",
      "",
      "export type TsIrResult = {",
      "  readonly heap: Heap;",
      "  readonly logs: readonly runtime.DebugLogEntry[];",
      "};",
      "",
      `export function ${this.functionName}(): TsIrResult {`,
      "  runtime.clearDebugLogs();",
      "  const heap: Heap = {",
      ...Array.from(
        this.slots.values(),
        (slot) => `    ${JSON.stringify(slot.name)}: undefined,`,
      ),
      "  };",
      "  let pc = 0;",
      "  while (true) {",
      "    switch (pc) {",
    ];

    for (let pc = 0; pc < this.instructions.length; pc += 1) {
      lines.push(...this.emitCase(pc, this.instructions[pc] as TACInstruction));
    }

    lines.push(
      `      case ${this.instructions.length}:`,
      "        return { heap, logs: [...runtime.debugLogs] };",
      "      default:",
      "        throw new runtime.UdonVMRuntimeError(`Invalid TS IR pc ${pc}`, pc);",
      "    }",
      "  }",
      "}",
      "",
    );

    return {
      code: lines.join("\n"),
      labels: Object.fromEntries(this.labels),
      heapSlots: Object.fromEntries(
        Array.from(this.slots, ([name, slot]) => [name, slot.type]),
      ),
    };
  }

  private collectLabelsAndSlots(): void {
    for (let pc = 0; pc < this.instructions.length; pc += 1) {
      const instruction = this.instructions[pc] as TACInstruction;
      if (instruction.kind === TACInstructionKind.Label) {
        const label = (instruction as LabelInstruction).label;
        this.labels.set(operandToString(label), pc);
      }
      this.collectInstructionSlots(instruction);
    }
  }

  private collectInstructionSlots(instruction: TACInstruction): void {
    switch (instruction.kind) {
      case TACInstructionKind.Assignment: {
        const inst = instruction as AssignmentInstruction;
        this.collectOperandSlot(inst.dest);
        this.collectOperandSlot(inst.src);
        return;
      }
      case TACInstructionKind.Copy: {
        const inst = instruction as CopyInstruction;
        this.collectOperandSlot(inst.dest);
        this.collectOperandSlot(inst.src);
        return;
      }
      case TACInstructionKind.BinaryOp: {
        const inst = instruction as BinaryOpInstruction;
        this.collectOperandSlot(inst.dest);
        this.collectOperandSlot(inst.left);
        this.collectOperandSlot(inst.right);
        return;
      }
      case TACInstructionKind.Cast: {
        const inst = instruction as CastInstruction;
        this.collectOperandSlot(inst.dest);
        this.collectOperandSlot(inst.src);
        return;
      }
      case TACInstructionKind.ConditionalJump: {
        this.collectOperandSlot(
          (instruction as ConditionalJumpInstruction).condition,
        );
        return;
      }
      case TACInstructionKind.UnconditionalJump:
      case TACInstructionKind.Label:
        return;
      case TACInstructionKind.Call: {
        const inst = instruction as CallInstruction;
        if (inst.dest) this.collectOperandSlot(inst.dest);
        for (const arg of inst.args) this.collectOperandSlot(arg);
        return;
      }
      case TACInstructionKind.MethodCall: {
        const inst = instruction as MethodCallInstruction;
        if (inst.dest) this.collectOperandSlot(inst.dest);
        this.collectOperandSlot(inst.object);
        for (const arg of inst.args) this.collectOperandSlot(arg);
        return;
      }
      case TACInstructionKind.PropertyGet: {
        const inst = instruction as PropertyGetInstruction;
        this.collectOperandSlot(inst.dest);
        this.collectOperandSlot(inst.object);
        return;
      }
      case TACInstructionKind.PropertySet: {
        const inst = instruction as PropertySetInstruction;
        this.collectOperandSlot(inst.object);
        this.collectOperandSlot(inst.value);
        return;
      }
      case TACInstructionKind.Return: {
        const inst = instruction as ReturnInstruction;
        if (inst.value) this.collectOperandSlot(inst.value);
        return;
      }
      default:
        return;
    }
  }

  private collectOperandSlot(operand: TACOperand): void {
    if (
      operand.kind !== TACOperandKind.Variable &&
      operand.kind !== TACOperandKind.Temporary
    ) {
      return;
    }
    const name = this.slotName(operand);
    if (this.slots.has(name)) return;
    const type = this.slotType(
      (operand as VariableOperand | TemporaryOperand).type,
    );
    this.slots.set(name, { name, type });
  }

  private emitCase(pc: number, instruction: TACInstruction): string[] {
    const ctx = this.contextLiteral(pc, instruction);
    const next = pc + 1;
    const lines = [
      `      case ${pc}: {`,
      `        // TAC ${pc}: ${instruction.toString()}`,
      `        const ctx = ${ctx};`,
    ];

    switch (instruction.kind) {
      case TACInstructionKind.Assignment: {
        const inst = instruction as AssignmentInstruction;
        lines.push(
          this.emitAssignment(inst.dest, this.readExpression(inst.src, "ctx")),
        );
        lines.push(`        pc = ${next};`);
        break;
      }
      case TACInstructionKind.Copy: {
        const inst = instruction as CopyInstruction;
        lines.push(
          this.emitAssignment(inst.dest, this.readExpression(inst.src, "ctx")),
        );
        lines.push(`        pc = ${next};`);
        break;
      }
      case TACInstructionKind.BinaryOp: {
        const inst = instruction as BinaryOpInstruction;
        const expr = `runtime.binaryOp(${this.readExpression(inst.left, "ctx")}, ${JSON.stringify(inst.operator)}, ${this.readExpression(inst.right, "ctx")}, ctx)`;
        lines.push(this.emitAssignment(inst.dest, expr));
        lines.push(`        pc = ${next};`);
        break;
      }
      case TACInstructionKind.Cast: {
        const inst = instruction as CastInstruction;
        lines.push(
          this.emitAssignment(
            inst.dest,
            this.castExpression(inst.dest, inst.src, "ctx"),
          ),
        );
        lines.push(`        pc = ${next};`);
        break;
      }
      case TACInstructionKind.ConditionalJump: {
        const inst = instruction as ConditionalJumpInstruction;
        lines.push(
          `        pc = runtime.coerceBool(${this.readExpression(inst.condition, "ctx")}) ? ${next} : ${this.labelPc(inst.label)};`,
        );
        break;
      }
      case TACInstructionKind.UnconditionalJump: {
        const inst = instruction as UnconditionalJumpInstruction;
        lines.push(`        pc = ${this.labelPc(inst.label)};`);
        break;
      }
      case TACInstructionKind.Label:
        lines.push(`        pc = ${next};`);
        break;
      case TACInstructionKind.Call: {
        const inst = instruction as CallInstruction;
        const args = `[${inst.args.map((arg) => this.readExpression(arg, "ctx")).join(", ")}]`;
        const expr = `runtime.dispatchExtern(${JSON.stringify(inst.func)}, ${args}, ctx)`;
        if (inst.dest) {
          lines.push(this.emitAssignment(inst.dest, expr));
        } else {
          lines.push(`        ${expr};`);
        }
        lines.push(`        pc = ${next};`);
        break;
      }
      case TACInstructionKind.MethodCall: {
        const inst = instruction as MethodCallInstruction;
        const args = `[${inst.args.map((arg) => this.readExpression(arg, "ctx")).join(", ")}]`;
        const expr = `runtime.callMethod(${this.readExpression(inst.object, "ctx")}, ${JSON.stringify(inst.method)}, ${args}, ctx)`;
        if (inst.dest) {
          lines.push(this.emitAssignment(inst.dest, expr));
        } else {
          lines.push(`        ${expr};`);
        }
        lines.push(`        pc = ${next};`);
        break;
      }
      case TACInstructionKind.PropertyGet: {
        const inst = instruction as PropertyGetInstruction;
        const expr = `runtime.getProperty(${this.readExpression(inst.object, "ctx")}, ${JSON.stringify(inst.property)}, ctx)`;
        lines.push(this.emitAssignment(inst.dest, expr));
        lines.push(`        pc = ${next};`);
        break;
      }
      case TACInstructionKind.PropertySet: {
        const inst = instruction as PropertySetInstruction;
        lines.push(
          `        runtime.setProperty(${this.readExpression(inst.object, "ctx")}, ${JSON.stringify(inst.property)}, ${this.readExpression(inst.value, "ctx")}, ctx);`,
        );
        lines.push(`        pc = ${next};`);
        break;
      }
      case TACInstructionKind.Return: {
        const inst = instruction as ReturnInstruction;
        if (inst.value && inst.returnVarName) {
          lines.push(
            `        heap[${JSON.stringify(inst.returnVarName)}] = ${this.readExpression(inst.value, "ctx")} as Heap[${JSON.stringify(inst.returnVarName)}];`,
          );
        }
        lines.push("        return { heap, logs: [...runtime.debugLogs] };");
        break;
      }
      default:
        lines.push(
          `        throw new runtime.UdonVMRuntimeError(${JSON.stringify(`Unsupported TAC instruction kind '${instruction.kind}'`)}, ${pc}, ${JSON.stringify(instruction.toString())});`,
        );
        break;
    }

    lines.push("        break;", "      }");
    return lines;
  }

  private emitAssignment(dest: TACOperand, expr: string): string {
    const slot = this.slotName(dest);
    return `        heap[${JSON.stringify(slot)}] = ${expr} as Heap[${JSON.stringify(slot)}];`;
  }

  private readExpression(operand: TACOperand, ctxName: string): string {
    switch (operand.kind) {
      case TACOperandKind.Variable:
      case TACOperandKind.Temporary: {
        const slot = this.slotName(operand);
        return `runtime.readSlot(heap[${JSON.stringify(slot)}], ${JSON.stringify(slot)}, ${ctxName})`;
      }
      case TACOperandKind.Constant:
        return this.constantExpression(operand as ConstantOperand);
      case TACOperandKind.Label:
        return JSON.stringify(operandToString(operand));
    }
  }

  private castExpression(
    dest: TACOperand,
    src: TACOperand,
    ctxName: string,
  ): string {
    const source = this.readExpression(src, ctxName);
    const type = this.operandType(dest);
    switch (type?.udonType) {
      case UdonType.Int32:
      case UdonType.Byte:
      case UdonType.SByte:
      case UdonType.Int16:
      case UdonType.UInt16:
      case UdonType.UInt32:
      case UdonType.Int64:
      case UdonType.UInt64:
        return `runtime.castInt(${source})`;
      case UdonType.Single:
      case UdonType.Double:
        return `runtime.castFloat(${source})`;
      case UdonType.Boolean:
        return `runtime.coerceBool(${source})`;
      default:
        return source;
    }
  }

  private constantExpression(operand: ConstantOperand): string {
    if (typeof operand.value === "bigint") {
      return `${operand.value.toString()}n`;
    }
    return JSON.stringify(operand.value);
  }

  private labelPc(label: TACOperand): number {
    const name = operandToString(label);
    const pc = this.labels.get(name);
    if (pc === undefined) {
      throw new Error(`Unknown TAC label '${name}'`);
    }
    return pc;
  }

  private contextLiteral(pc: number, instruction: TACInstruction): string {
    return `{ pc: ${pc}, instruction: ${JSON.stringify(instruction.toString())} }`;
  }

  private slotName(operand: TACOperand): string {
    switch (operand.kind) {
      case TACOperandKind.Variable:
        return (operand as VariableOperand).name === "this"
          ? "__this"
          : (operand as VariableOperand).name;
      case TACOperandKind.Temporary:
        return `__t${(operand as TemporaryOperand).id}`;
      default:
        throw new Error(
          `Operand '${operandToString(operand)}' is not a heap slot`,
        );
    }
  }

  private slotType(type: TypeSymbol): string {
    const base = this.tsTypeForUdon(type);
    return `${base} | undefined`;
  }

  private tsTypeForUdon(type: TypeSymbol): string {
    if (type.name.toLowerCase().includes("handle")) {
      return "runtime.MaybeHandle<unknown>";
    }
    switch (type.udonType) {
      case UdonType.Int32:
      case UdonType.Single:
      case UdonType.Byte:
      case UdonType.SByte:
      case UdonType.Int16:
      case UdonType.UInt16:
      case UdonType.UInt32:
      case UdonType.Int64:
      case UdonType.UInt64:
      case UdonType.Double:
        return "number";
      case UdonType.Boolean:
        return "boolean";
      case UdonType.String:
        return "string";
      case UdonType.DataList:
      case UdonType.Array:
      case UdonType.NativeArray:
        return "runtime.DataList<unknown> | null";
      case UdonType.DataDictionary:
        return "runtime.DataDictionary<unknown, unknown> | null";
      case UdonType.DataToken:
        return "runtime.DataToken<unknown> | null";
      case UdonType.Void:
        return "undefined";
      default:
        return "unknown";
    }
  }

  private operandType(operand: TACOperand): TypeSymbol | undefined {
    if (
      operand.kind === TACOperandKind.Variable ||
      operand.kind === TACOperandKind.Temporary ||
      operand.kind === TACOperandKind.Constant
    ) {
      return (operand as VariableOperand | TemporaryOperand | ConstantOperand)
        .type;
    }
    return undefined;
  }
}

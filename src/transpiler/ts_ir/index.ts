import fs from "node:fs";
import type { TypeSymbol } from "../frontend/type_symbols.js";
import { UdonType } from "../frontend/types.js";
import {
  type AssignmentInstruction,
  type ArrayAccessInstruction,
  type ArrayAssignmentInstruction,
  type BinaryOpInstruction,
  type CallInstruction,
  type CastInstruction,
  type ConditionalJumpInstruction,
  type CopyInstruction,
  type LabelInstruction,
  type MethodCallInstruction,
  type PropertyGetInstruction,
  type PropertySetInstruction,
  type PhiInstruction,
  type ReturnInstruction,
  type TACInstruction,
  TACInstructionKind,
  type UnaryOpInstruction,
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
  compact?: boolean;
  mode?: "switch" | "linear" | "data";
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

export function emitTsIrToFile(
  instructions: readonly TACInstruction[],
  filePath: string,
  options: TsIrEmitOptions = {},
): TsIrEmitResult {
  return new TsIrEmitter(instructions, options).emitToFile(filePath);
}

class TsIrEmitter {
  private readonly labels = new Map<string, number>();
  private readonly slots = new Map<string, SlotInfo>();
  private readonly moduleImportPath: string;
  private readonly functionName: string;
  private readonly compact: boolean;
  private readonly mode: "switch" | "linear" | "data";
  private readonly slotIdentifiers = new Map<string, string>();

  constructor(
    private readonly instructions: readonly TACInstruction[],
    options: TsIrEmitOptions,
  ) {
    this.moduleImportPath = options.moduleImportPath ?? "../runtime/index.js";
    this.functionName = options.functionName ?? "runTsIr";
    this.compact = options.compact === true;
    this.mode = options.mode ?? "switch";
  }

  emit(): TsIrEmitResult {
    this.collectLabelsAndSlots();
    const lines: string[] = [...this.headerLines()];

    for (let pc = 0; pc < this.instructions.length; pc += 1) {
      lines.push(...this.emitCase(pc, this.instructions[pc] as TACInstruction));
    }

    lines.push(...this.footerLines());

    return {
      code: lines.join("\n"),
      labels: Object.fromEntries(this.labels),
      heapSlots: Object.fromEntries(
        Array.from(this.slots, ([name, slot]) => [name, slot.type]),
      ),
    };
  }

  emitToFile(filePath: string): TsIrEmitResult {
    this.collectLabelsAndSlots();
    if (this.mode === "data") {
      return this.emitDataToFile(filePath);
    }
    if (this.mode === "linear") {
      return this.emitLinearToFile(filePath);
    }
    const fd = fs.openSync(filePath, "w");
    try {
      for (const line of this.headerLines()) {
        fs.writeSync(fd, `${line}\n`);
      }
      for (let pc = 0; pc < this.instructions.length; pc += 1) {
        for (const line of this.emitCase(
          pc,
          this.instructions[pc] as TACInstruction,
        )) {
          fs.writeSync(fd, `${line}\n`);
        }
      }
      for (const line of this.footerLines()) {
        fs.writeSync(fd, `${line}\n`);
      }
    } finally {
      fs.closeSync(fd);
    }
    return {
      code: "",
      labels: Object.fromEntries(this.labels),
      heapSlots: Object.fromEntries(
        Array.from(this.slots, ([name, slot]) => [name, slot.type]),
      ),
    };
  }

  private emitLinearToFile(filePath: string): TsIrEmitResult {
    this.buildSlotIdentifiers();
    const fd = fs.openSync(filePath, "w");
    const write = (line: string): void => {
      fs.writeSync(fd, `${line}\n`);
    };
    try {
      for (const line of this.linearHeaderLines()) write(line);
      for (const start of this.linearBlockStarts()) {
        write(`      case ${start}: {`);
        const end = this.linearBlockEnd(start);
        for (let pc = start; pc < end; pc += 1) {
          for (const line of this.emitLinearInstruction(
            pc,
            this.instructions[pc] as TACInstruction,
          )) {
            write(line);
          }
        }
        const last = this.instructions[end - 1] as TACInstruction | undefined;
        if (!last || !this.isTerminator(last)) {
          write(`        pc = ${end};`);
          write("        continue;");
        }
        write("      }");
      }
      for (const line of this.linearFooterLines()) write(line);
    } finally {
      fs.closeSync(fd);
    }
    return {
      code: "",
      labels: Object.fromEntries(this.labels),
      heapSlots: Object.fromEntries(
        Array.from(this.slots, ([name, slot]) => [name, slot.type]),
      ),
    };
  }

  private emitDataToFile(filePath: string): TsIrEmitResult {
    const fd = fs.openSync(filePath, "w");
    const write = (text: string): void => {
      fs.writeSync(fd, text);
    };
    try {
      write(`import * as runtime from ${JSON.stringify(this.moduleImportPath)};\n\n`);
      write("const program = JSON.parse(`[\n");
      for (let pc = 0; pc < this.instructions.length; pc += 1) {
        if (pc > 0) write(",\n");
        write(
          escapeTemplateJson(
            JSON.stringify(this.dataInstruction(this.instructions[pc] as TACInstruction)),
          ),
        );
      }
      write("\n]`);\n\n");
      write(`export function ${this.functionName}() {\n`);
      write("  return runtime.runTacProgram(program);\n");
      write("}\n");
    } finally {
      fs.closeSync(fd);
    }
    return {
      code: "",
      labels: Object.fromEntries(this.labels),
      heapSlots: Object.fromEntries(
        Array.from(this.slots, ([name, slot]) => [name, slot.type]),
      ),
    };
  }

  private headerLines(): string[] {
    return [
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
  }

  private footerLines(): string[] {
    return [
      `      case ${this.instructions.length}:`,
      "        return { heap, logs: [...runtime.debugLogs] };",
      "      default:",
      "        throw new runtime.UdonVMRuntimeError(`Invalid TS IR pc ${pc}`, pc);",
      "    }",
      "  }",
      "}",
      "",
    ];
  }

  private linearHeaderLines(): string[] {
    return [
      `import * as runtime from ${JSON.stringify(this.moduleImportPath)};`,
      "",
      "export type Heap = Record<string, unknown>;",
      "",
      "export type TsIrResult = {",
      "  readonly heap: Heap;",
      "  readonly logs: readonly runtime.DebugLogEntry[];",
      "};",
      "",
      `export function ${this.functionName}(): TsIrResult {`,
      "  runtime.clearDebugLogs();",
      "  const ctx = {};",
      "  const heap: Heap = {};",
      ...this.linearSlotDeclarationLines(),
      "  let pc = 0;",
      "  while (true) {",
      "    switch (pc) {",
    ];
  }

  private linearFooterLines(): string[] {
    return [
      `      case ${this.instructions.length}:`,
      "        return { heap, logs: [...runtime.debugLogs] };",
      "      default:",
      "        throw new runtime.UdonVMRuntimeError(`Invalid TS IR pc ${pc}`, pc);",
      "    }",
      "  }",
      "}",
      "",
    ];
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
      case TACInstructionKind.UnaryOp: {
        const inst = instruction as UnaryOpInstruction;
        this.collectOperandSlot(inst.dest);
        this.collectOperandSlot(inst.operand);
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
      case TACInstructionKind.ArrayAccess: {
        const inst = instruction as ArrayAccessInstruction;
        this.collectOperandSlot(inst.dest);
        this.collectOperandSlot(inst.array);
        this.collectOperandSlot(inst.index);
        return;
      }
      case TACInstructionKind.ArrayAssignment: {
        const inst = instruction as ArrayAssignmentInstruction;
        this.collectOperandSlot(inst.array);
        this.collectOperandSlot(inst.index);
        this.collectOperandSlot(inst.value);
        return;
      }
      case TACInstructionKind.Phi: {
        const inst = instruction as PhiInstruction;
        this.collectOperandSlot(inst.dest);
        for (const source of inst.sources) this.collectOperandSlot(source.value);
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
    const lines = [`      case ${pc}: {`];
    if (!this.compact) {
      lines.push(`        // TAC ${pc}: ${instruction.toString()}`);
    }
    lines.push(`        const ctx = ${ctx};`);

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
      case TACInstructionKind.UnaryOp: {
        const inst = instruction as UnaryOpInstruction;
        const expr = `runtime.unaryOp(${JSON.stringify(inst.operator)}, ${this.readExpression(inst.operand, "ctx")}, ctx)`;
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

  private emitLinearInstruction(
    pc: number,
    instruction: TACInstruction,
  ): string[] {
    const next = pc + 1;
    const lines = this.compact
      ? []
      : [`        const ctx${pc} = ${this.contextLiteral(pc, instruction)};`];
    const ctxName = this.compact ? "ctx" : `ctx${pc}`;

    switch (instruction.kind) {
      case TACInstructionKind.Assignment: {
        const inst = instruction as AssignmentInstruction;
        lines.push(
          this.emitLinearAssignment(
            inst.dest,
            this.readLinearExpression(inst.src, ctxName),
          ),
        );
        break;
      }
      case TACInstructionKind.Copy: {
        const inst = instruction as CopyInstruction;
        lines.push(
          this.emitLinearAssignment(
            inst.dest,
            this.readLinearExpression(inst.src, ctxName),
          ),
        );
        break;
      }
      case TACInstructionKind.BinaryOp: {
        const inst = instruction as BinaryOpInstruction;
        const expr = this.linearBinaryExpression(inst, ctxName);
        lines.push(this.emitLinearAssignment(inst.dest, expr));
        break;
      }
      case TACInstructionKind.UnaryOp: {
        const inst = instruction as UnaryOpInstruction;
        const expr = this.linearUnaryExpression(inst, ctxName);
        lines.push(this.emitLinearAssignment(inst.dest, expr));
        break;
      }
      case TACInstructionKind.Cast: {
        const inst = instruction as CastInstruction;
        lines.push(
          this.emitLinearAssignment(
            inst.dest,
            this.castLinearExpression(inst.dest, inst.src, ctxName),
          ),
        );
        break;
      }
      case TACInstructionKind.ConditionalJump: {
        const inst = instruction as ConditionalJumpInstruction;
        lines.push(
          `        pc = runtime.coerceBool(${this.readLinearExpression(inst.condition, ctxName)}) ? ${next} : ${this.labelPc(inst.label)};`,
          "        continue;",
        );
        break;
      }
      case TACInstructionKind.UnconditionalJump: {
        const inst = instruction as UnconditionalJumpInstruction;
        lines.push(
          `        pc = ${this.labelPc(inst.label)};`,
          "        continue;",
        );
        break;
      }
      case TACInstructionKind.Label:
        break;
      case TACInstructionKind.Call: {
        const inst = instruction as CallInstruction;
        const args = `[${inst.args.map((arg) => this.readLinearExpression(arg, ctxName)).join(", ")}]`;
        const expr = this.compact
          ? `runtime.dispatchExtern(${JSON.stringify(inst.func)}, ${args})`
          : `runtime.dispatchExtern(${JSON.stringify(inst.func)}, ${args}, ${ctxName})`;
        if (inst.dest) lines.push(this.emitLinearAssignment(inst.dest, expr));
        else lines.push(`        ${expr};`);
        break;
      }
      case TACInstructionKind.MethodCall: {
        const inst = instruction as MethodCallInstruction;
        const args = `[${inst.args.map((arg) => this.readLinearExpression(arg, ctxName)).join(", ")}]`;
        const expr = this.compact
          ? `runtime.callMethod(${this.readLinearExpression(inst.object, ctxName)}, ${JSON.stringify(inst.method)}, ${args})`
          : `runtime.callMethod(${this.readLinearExpression(inst.object, ctxName)}, ${JSON.stringify(inst.method)}, ${args}, ${ctxName})`;
        if (inst.dest) lines.push(this.emitLinearAssignment(inst.dest, expr));
        else lines.push(`        ${expr};`);
        break;
      }
      case TACInstructionKind.PropertyGet: {
        const inst = instruction as PropertyGetInstruction;
        const expr = this.compact
          ? `runtime.getProperty(${this.readLinearExpression(inst.object, ctxName)}, ${JSON.stringify(inst.property)})`
          : `runtime.getProperty(${this.readLinearExpression(inst.object, ctxName)}, ${JSON.stringify(inst.property)}, ${ctxName})`;
        lines.push(this.emitLinearAssignment(inst.dest, expr));
        break;
      }
      case TACInstructionKind.PropertySet: {
        const inst = instruction as PropertySetInstruction;
        const args = `${this.readLinearExpression(inst.object, ctxName)}, ${JSON.stringify(inst.property)}, ${this.readLinearExpression(inst.value, ctxName)}`;
        lines.push(
          this.compact
            ? `        runtime.setProperty(${args});`
            : `        runtime.setProperty(${args}, ${ctxName});`,
        );
        break;
      }
      case TACInstructionKind.Return: {
        const inst = instruction as ReturnInstruction;
        if (inst.value && inst.returnVarName) {
          lines.push(
            `        heap[${JSON.stringify(inst.returnVarName)}] = ${this.readLinearExpression(inst.value, ctxName)};`,
          );
        }
        lines.push("        return { heap, logs: [...runtime.debugLogs] };");
        break;
      }
      default:
        lines.push(
          `        throw new runtime.UdonVMRuntimeError(${JSON.stringify(`Unsupported TAC instruction kind '${instruction.kind}'`)}, ${pc}, ${this.compact ? "undefined" : JSON.stringify(instruction.toString())});`,
        );
        break;
    }
    return lines;
  }

  private emitLinearAssignment(dest: TACOperand, expr: string): string {
    const id = this.slotIdentifier(this.slotName(dest));
    if (this.compact) return `        ${id} = ${expr};`;
    return `        ${id} = ${expr} as typeof ${id};`;
  }

  private linearSlotDeclarationLines(): string[] {
    const ids = Array.from(this.slots.values(), (slot) =>
      this.slotIdentifier(slot.name),
    );
    if (!this.compact) {
      return Array.from(
        this.slots.values(),
        (slot) =>
          `  let ${this.slotIdentifier(slot.name)}: ${slot.type} = undefined;`,
      );
    }
    const lines: string[] = [];
    for (let index = 0; index < ids.length; index += 80) {
      lines.push(`  let ${ids.slice(index, index + 80).join(", ")};`);
    }
    return lines;
  }

  private linearBinaryExpression(
    inst: BinaryOpInstruction,
    ctxName: string,
  ): string {
    const left = this.readLinearExpression(inst.left, ctxName);
    const right = this.readLinearExpression(inst.right, ctxName);
    if (!this.compact) {
      return `runtime.binaryOp(${left}, ${JSON.stringify(inst.operator)}, ${right}, ${ctxName})`;
    }
    switch (inst.operator) {
      case "+":
        return `(${left}+${right})`;
      case "-":
      case "*":
      case "/":
      case "%":
      case "<<":
      case ">>":
      case "<":
      case "<=":
      case ">":
      case ">=":
      case "===":
      case "!==":
        return `(${left}${inst.operator}${right})`;
      case "&&":
        return `(runtime.coerceBool(${left})&&runtime.coerceBool(${right}))`;
      case "||":
        return `(runtime.coerceBool(${left})||runtime.coerceBool(${right}))`;
      case "==":
        return `(${left}===${right})`;
      case "!=":
        return `(${left}!==${right})`;
      default:
        return `runtime.binaryOp(${left}, ${JSON.stringify(inst.operator)})`;
    }
  }

  private linearUnaryExpression(inst: UnaryOpInstruction, ctxName: string): string {
    const operand = this.readLinearExpression(inst.operand, ctxName);
    if (!this.compact) {
      return `runtime.unaryOp(${JSON.stringify(inst.operator)}, ${operand}, ${ctxName})`;
    }
    switch (inst.operator) {
      case "!":
        return `(!runtime.coerceBool(${operand}))`;
      case "-":
      case "+":
      case "~":
        return `(${inst.operator}${operand})`;
      default:
        return `runtime.unaryOp(${JSON.stringify(inst.operator)}, ${operand})`;
    }
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

  private readLinearExpression(operand: TACOperand, ctxName: string): string {
    switch (operand.kind) {
      case TACOperandKind.Variable:
      case TACOperandKind.Temporary: {
        const slot = this.slotName(operand);
        const id = this.slotIdentifier(slot);
        if (this.compact) return id;
        return `runtime.readSlot(${id}, ${JSON.stringify(slot)}, ${ctxName})`;
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

  private castLinearExpression(
    dest: TACOperand,
    src: TACOperand,
    ctxName: string,
  ): string {
    const source = this.readLinearExpression(src, ctxName);
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
    if (this.compact) {
      return `{ pc: ${pc} }`;
    }
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

  private buildSlotIdentifiers(): void {
    const used = new Set<string>();
    for (const slot of this.slots.keys()) {
      const base = sanitizeIdentifier(slot);
      let id = base;
      let suffix = 1;
      while (used.has(id)) {
        id = `${base}_${suffix}`;
        suffix += 1;
      }
      used.add(id);
      this.slotIdentifiers.set(slot, id);
    }
  }

  private slotIdentifier(slot: string): string {
    const existing = this.slotIdentifiers.get(slot);
    if (existing) return existing;
    const id = sanitizeIdentifier(slot);
    this.slotIdentifiers.set(slot, id);
    return id;
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

  private linearBlockStarts(): number[] {
    const starts = new Set<number>([0]);
    for (let pc = 0; pc < this.instructions.length; pc += 1) {
      const instruction = this.instructions[pc] as TACInstruction;
      if (instruction.kind === TACInstructionKind.Label) {
        starts.add(pc);
      }
      if (this.isTerminator(instruction) && pc + 1 < this.instructions.length) {
        starts.add(pc + 1);
      }
    }
    starts.add(this.instructions.length);
    return Array.from(starts)
      .filter((start) => start < this.instructions.length)
      .sort((a, b) => a - b);
  }

  private linearBlockEnd(start: number): number {
    for (let pc = start + 1; pc < this.instructions.length; pc += 1) {
      const instruction = this.instructions[pc] as TACInstruction;
      if (instruction.kind === TACInstructionKind.Label) return pc;
      const prev = this.instructions[pc - 1] as TACInstruction;
      if (this.isTerminator(prev)) return pc;
    }
    return this.instructions.length;
  }

  private isTerminator(instruction: TACInstruction): boolean {
    return (
      instruction.kind === TACInstructionKind.ConditionalJump ||
      instruction.kind === TACInstructionKind.UnconditionalJump ||
      instruction.kind === TACInstructionKind.Return
    );
  }

  private dataInstruction(instruction: TACInstruction): unknown[] {
    switch (instruction.kind) {
      case TACInstructionKind.Assignment: {
        const inst = instruction as AssignmentInstruction;
        return ["a", this.slotName(inst.dest), this.dataOperand(inst.src)];
      }
      case TACInstructionKind.Copy: {
        const inst = instruction as CopyInstruction;
        return ["a", this.slotName(inst.dest), this.dataOperand(inst.src)];
      }
      case TACInstructionKind.BinaryOp: {
        const inst = instruction as BinaryOpInstruction;
        return [
          "b",
          this.slotName(inst.dest),
          inst.operator,
          this.dataOperand(inst.left),
          this.dataOperand(inst.right),
        ];
      }
      case TACInstructionKind.UnaryOp: {
        const inst = instruction as UnaryOpInstruction;
        return [
          "u",
          this.slotName(inst.dest),
          inst.operator,
          this.dataOperand(inst.operand),
        ];
      }
      case TACInstructionKind.Cast: {
        const inst = instruction as CastInstruction;
        return [
          "c",
          this.slotName(inst.dest),
          this.castCode(inst.dest),
          this.dataOperand(inst.src),
        ];
      }
      case TACInstructionKind.ConditionalJump: {
        const inst = instruction as ConditionalJumpInstruction;
        return ["cj", this.dataOperand(inst.condition), this.labelPc(inst.label)];
      }
      case TACInstructionKind.UnconditionalJump: {
        const inst = instruction as UnconditionalJumpInstruction;
        return ["j", this.labelPc(inst.label)];
      }
      case TACInstructionKind.Label:
        return ["l"];
      case TACInstructionKind.Call: {
        const inst = instruction as CallInstruction;
        return [
          "call",
          inst.dest ? this.slotName(inst.dest) : null,
          inst.func,
          inst.args.map((arg) => this.dataOperand(arg)),
        ];
      }
      case TACInstructionKind.MethodCall: {
        const inst = instruction as MethodCallInstruction;
        return [
          "m",
          inst.dest ? this.slotName(inst.dest) : null,
          this.dataOperand(inst.object),
          inst.method,
          inst.args.map((arg) => this.dataOperand(arg)),
        ];
      }
      case TACInstructionKind.PropertyGet: {
        const inst = instruction as PropertyGetInstruction;
        return [
          "pg",
          this.slotName(inst.dest),
          this.dataOperand(inst.object),
          inst.property,
        ];
      }
      case TACInstructionKind.PropertySet: {
        const inst = instruction as PropertySetInstruction;
        return [
          "ps",
          this.dataOperand(inst.object),
          inst.property,
          this.dataOperand(inst.value),
        ];
      }
      case TACInstructionKind.Return: {
        const inst = instruction as ReturnInstruction;
        return [
          "r",
          inst.value ? this.dataOperand(inst.value) : null,
          inst.returnVarName ?? null,
        ];
      }
      case TACInstructionKind.ArrayAccess: {
        const inst = instruction as ArrayAccessInstruction;
        return [
          "ag",
          this.slotName(inst.dest),
          this.dataOperand(inst.array),
          this.dataOperand(inst.index),
        ];
      }
      case TACInstructionKind.ArrayAssignment: {
        const inst = instruction as ArrayAssignmentInstruction;
        return [
          "aa",
          this.dataOperand(inst.array),
          this.dataOperand(inst.index),
          this.dataOperand(inst.value),
        ];
      }
      case TACInstructionKind.Phi: {
        const inst = instruction as PhiInstruction;
        return [
          "unsupported",
          `${instruction.kind}: ${inst.toString()}`,
        ];
      }
      default:
        return ["unsupported", instruction.kind];
    }
  }

  private dataOperand(operand: TACOperand): unknown[] {
    switch (operand.kind) {
      case TACOperandKind.Variable:
      case TACOperandKind.Temporary:
        return ["s", this.slotName(operand)];
      case TACOperandKind.Constant: {
        const constant = operand as ConstantOperand;
        if (typeof constant.value === "bigint") {
          return ["bi", constant.value.toString()];
        }
        return ["k", constant.value];
      }
      case TACOperandKind.Label:
        return ["label", operandToString(operand)];
    }
  }

  private castCode(dest: TACOperand): string {
    switch (this.operandType(dest)?.udonType) {
      case UdonType.Int32:
      case UdonType.Byte:
      case UdonType.SByte:
      case UdonType.Int16:
      case UdonType.UInt16:
      case UdonType.UInt32:
      case UdonType.Int64:
      case UdonType.UInt64:
        return "i";
      case UdonType.Single:
      case UdonType.Double:
        return "f";
      case UdonType.Boolean:
        return "b";
      default:
        return "n";
    }
  }
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_$]/g, "_");
  if (/^[A-Za-z_$]/.test(sanitized)) return sanitized;
  return `_${sanitized}`;
}

function escapeTemplateJson(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/**
 * Convert TAC to Udon Assembly instructions
 */

import {
  type AssignmentInstruction as TACAssignmentInstruction,
  type BinaryOpInstruction as TACBinaryOpInstruction,
  type CallInstruction as TACCallInstruction,
  type CastInstruction as TACCastInstruction,
  type ConditionalJumpInstruction as TACConditionalJumpInstruction,
  type CopyInstruction as TACCopyInstruction,
  type TACInstruction,
  TACInstructionKind,
  type LabelInstruction as TACLabelInstruction,
  type MethodCallInstruction as TACMethodCallInstruction,
  type PropertyGetInstruction as TACPropertyGetInstruction,
  type PropertySetInstruction as TACPropertySetInstruction,
  type ReturnInstruction as TACReturnInstruction,
  type UnaryOpInstruction as TACUnaryOpInstruction,
  type UnconditionalJumpInstruction as TACUnconditionalJumpInstruction,
} from "../ir/tac_instruction.js";
import {
  type ConstantOperand,
  type LabelOperand,
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
  type VariableOperand, // Remove duplicate if needed, but assuming unique imports
} from "../ir/tac_operand.js";
import { resolveExternSignature } from "./extern_signatures.js";
import {
  CopyInstruction,
  createUdonExternSignature,
  ExternInstruction,
  JumpIfFalseInstruction,
  JumpInstruction,
  LabelInstruction,
  PushInstruction,
  type UdonInstruction, // RetInstruction?
} from "./udon_instruction.js"; // Check this file content next

/**
 * TAC to Udon converter
 */
export class TACToUdonConverter {
  private static readonly digitOnlyPattern = /^\d+$/;
  private instructions: UdonInstruction[] = [];
  private variableAddresses: Map<string, number> = new Map();
  private variableTypes: Map<string, string> = new Map();
  private tempAddresses: Map<number, number> = new Map();
  private tempTypes: Map<number, string> = new Map();
  private constantAddresses: Map<string, number> = new Map();
  private constantTypes: Map<string, string> = new Map();
  private nextAddress = 0;
  private externSignatures: Set<string> = new Set();
  private externSymbolBySignature: Map<string, string> = new Map();
  private externAddressBySignature: Map<string, number> = new Map();
  private nextExternId = 0;
  private entryClassName: string | null = null;
  private inlineClassNames: Set<string> = new Set();

  /**
   * Convert TAC to Udon instructions
   */
  convert(
    tacInstructions: TACInstruction[],
    options?: { entryClassName?: string; inlineClassNames?: Set<string> },
  ): UdonInstruction[] {
    this.instructions = [];
    this.variableAddresses.clear();
    this.variableTypes.clear();
    this.tempAddresses.clear();
    this.tempTypes.clear();
    this.constantAddresses.clear();
    this.constantTypes.clear();
    this.externSignatures.clear();
    this.externSymbolBySignature.clear();
    this.externAddressBySignature.clear();
    this.nextAddress = 0;
    this.nextExternId = 0;
    this.entryClassName = options?.entryClassName ?? null;
    this.inlineClassNames = options?.inlineClassNames ?? new Set();

    for (const tacInst of tacInstructions) {
      this.convertInstruction(tacInst);
    }

    return this.instructions;
  }

  /**
   * Get extern signatures used
   */
  getExternSignatures(): string[] {
    return Array.from(this.externSignatures);
  }

  private getExternSymbol(signature: string): string {
    const existing = this.externSymbolBySignature.get(signature);
    if (existing) return existing;
    const symbol = `__extern_${this.nextExternId++}`;
    this.externSymbolBySignature.set(signature, symbol);
    this.externAddressBySignature.set(signature, this.nextAddress++);
    return symbol;
  }

  /**
   * Convert single TAC instruction
   */
  private convertInstruction(inst: TACInstruction): void {
    switch (inst.kind) {
      case TACInstructionKind.Assignment: // fallthrough
      case TACInstructionKind.Copy: {
        const assignInst = inst as
          | TACAssignmentInstruction
          | TACCopyInstruction;
        this.pushOperand(assignInst.src);
        const destAddr = this.getOperandAddress(assignInst.dest);
        this.instructions.push(new PushInstruction(destAddr));
        this.instructions.push(new CopyInstruction());
        break;
      }

      case TACInstructionKind.BinaryOp: {
        const binInst = inst as TACBinaryOpInstruction;
        this.pushOperand(binInst.left);
        this.pushOperand(binInst.right);

        // Call extern for operation
        const leftOp = binInst.left as
          | VariableOperand
          | ConstantOperand
          | TemporaryOperand;
        const leftType = leftOp.type;
        const externSig = this.getExternForBinaryOp(
          binInst.operator,
          leftType.udonType,
        );
        this.externSignatures.add(externSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(externSig), true),
        );

        // Store result
        const destAddr = this.getOperandAddress(binInst.dest);
        this.instructions.push(new PushInstruction(destAddr));
        this.instructions.push(new CopyInstruction());
        break;
      }

      case TACInstructionKind.UnaryOp: {
        const unInst = inst as TACUnaryOpInstruction;
        this.pushOperand(unInst.operand);

        // Call extern for operation
        const operandOp = unInst.operand as
          | VariableOperand
          | ConstantOperand
          | TemporaryOperand;
        // operandOp might be a LabelOperand in theory if TAC is broken, but safe to assume it has type if valid
        // Actually, let's correspond to the fix I made earlier exactly
        const operandType = operandOp.type?.udonType ?? "Single";
        const externSig = this.getExternForUnaryOp(
          unInst.operator,
          operandType,
        );
        this.externSignatures.add(externSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(externSig), true),
        );

        // Store result
        const destAddr = this.getOperandAddress(unInst.dest);
        this.instructions.push(new PushInstruction(destAddr));
        this.instructions.push(new CopyInstruction());
        break;
      }

      case TACInstructionKind.Cast: {
        const castInst = inst as TACCastInstruction;
        const sourceType = this.getOperandUdonType(castInst.src);
        const targetType = this.getOperandUdonType(castInst.dest);

        if (sourceType === targetType) {
          this.pushOperand(castInst.src);
          const destAddr = this.getOperandAddress(castInst.dest);
          this.instructions.push(new PushInstruction(destAddr));
          this.instructions.push(new CopyInstruction());
          break;
        }

        this.pushOperand(castInst.src);

        if (this.isFloatType(sourceType) && this.isIntegerType(targetType)) {
          if (sourceType === "Single") {
            const toDoubleSig = this.getConvertExternSignature(
              "Single",
              "Double",
            );
            this.externSignatures.add(toDoubleSig);
            this.instructions.push(
              new ExternInstruction(this.getExternSymbol(toDoubleSig), true),
            );
          }
          const truncateSig = this.getTruncateExternSignature();
          this.externSignatures.add(truncateSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(truncateSig), true),
          );

          const toTargetSig = this.getConvertExternSignature(
            "Double",
            targetType,
          );
          this.externSignatures.add(toTargetSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(toTargetSig), true),
          );
        } else {
          const toTargetSig = this.getConvertExternSignature(
            sourceType,
            targetType,
          );
          this.externSignatures.add(toTargetSig);
          this.instructions.push(
            new ExternInstruction(this.getExternSymbol(toTargetSig), true),
          );
        }

        const destAddr = this.getOperandAddress(castInst.dest);
        this.instructions.push(new PushInstruction(destAddr));
        this.instructions.push(new CopyInstruction());
        break;
      }

      case TACInstructionKind.ConditionalJump: {
        const condJump = inst as TACConditionalJumpInstruction;
        this.pushOperand(condJump.condition);
        const labelName = (condJump.label as LabelOperand).name;
        this.instructions.push(new JumpIfFalseInstruction(labelName));
        break;
      }

      case TACInstructionKind.UnconditionalJump: {
        const jump = inst as TACUnconditionalJumpInstruction;
        const labelName = (jump.label as LabelOperand).name;
        this.instructions.push(new JumpInstruction(labelName));
        break;
      }

      case TACInstructionKind.Label: {
        const label = inst as TACLabelInstruction;
        const labelName = (label.label as LabelOperand).name;
        this.instructions.push(new LabelInstruction(labelName));
        break;
      }

      case TACInstructionKind.Call: {
        const call = inst as TACCallInstruction;
        // Push arguments
        for (const arg of call.args) {
          this.pushOperand(arg);
        }

        // Call function
        let externSig = call.func;
        if (call.func.startsWith("__ctor_")) {
          const typeName = call.func.replace("__ctor_", "");
          externSig =
            resolveExternSignature(typeName, "ctor", "method") ??
            `${typeName}.__ctor__SystemSingle_SystemSingle_SystemSingle__${typeName}`;
        }
        // If it looks like a Udon extern signature (contains __), don't append ()
        if (!externSig.includes("__")) {
          externSig =
            resolveExternSignature(call.func, "", "method") ?? `${call.func}()`;
        }
        this.externSignatures.add(externSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(externSig), true),
        );

        // Store result if needed
        if (call.dest) {
          const destAddr = this.getOperandAddress(call.dest);
          this.instructions.push(new PushInstruction(destAddr));
          this.instructions.push(new CopyInstruction());
        }
        break;
      }

      case TACInstructionKind.MethodCall: {
        const call = inst as TACMethodCallInstruction;
        this.pushOperand(call.object);
        for (const arg of call.args) {
          this.pushOperand(arg);
        }

        const paramTypes = [
          this.getOperandTypeName(call.object),
          ...call.args.map((arg) => this.getOperandTypeName(arg)),
        ];
        const tsParamTypes = call.args.map((arg) =>
          this.getOperandTsTypeName(arg),
        );
        const returnType = call.dest
          ? this.getOperandTypeName(call.dest)
          : "Void";
        const tsReturnType = call.dest
          ? this.getOperandTsTypeName(call.dest)
          : "void";
        const objectTypeName = this.getOperandTsTypeName(call.object);
        let methodName = call.method;
        if (
          (objectTypeName === "String" || objectTypeName === "string") &&
          call.method === "Substring"
        ) {
          methodName =
            call.args.length === 2 ? "Substring(i,l)" : "Substring(i)";
        }
        const externSig =
          resolveExternSignature(
            objectTypeName,
            methodName,
            "method",
            tsParamTypes,
            tsReturnType,
          ) ?? createUdonExternSignature(methodName, paramTypes, returnType);
        this.externSignatures.add(externSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(externSig), true),
        );

        if (call.dest) {
          const destAddr = this.getOperandAddress(call.dest);
          this.instructions.push(new PushInstruction(destAddr));
          this.instructions.push(new CopyInstruction());
        }
        break;
      }

      case TACInstructionKind.PropertyGet: {
        const getInst = inst as TACPropertyGetInstruction;
        this.pushOperand(getInst.object);

        const paramTypes = [this.getOperandTypeName(getInst.object)];
        const tsParamTypes: string[] = [];
        const objectTypeName = this.getOperandTsTypeName(getInst.object);
        const returnType = this.getOperandTypeName(getInst.dest);
        const tsReturnType = this.getOperandTsTypeName(getInst.dest);
        const externSig =
          resolveExternSignature(
            objectTypeName,
            getInst.property,
            "getter",
            tsParamTypes,
            tsReturnType,
          ) ??
          createUdonExternSignature(
            `get_${getInst.property}`,
            paramTypes,
            returnType,
          );
        this.externSignatures.add(externSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(externSig), true),
        );

        const destAddr = this.getOperandAddress(getInst.dest);
        this.instructions.push(new PushInstruction(destAddr));
        this.instructions.push(new CopyInstruction());
        break;
      }

      case TACInstructionKind.PropertySet: {
        const setInst = inst as TACPropertySetInstruction;
        this.pushOperand(setInst.object);
        this.pushOperand(setInst.value);

        const paramTypes = [
          this.getOperandTypeName(setInst.object),
          this.getOperandTypeName(setInst.value),
        ];
        const tsParamTypes = [this.getOperandTsTypeName(setInst.value)];
        const objectTypeName = this.getOperandTsTypeName(setInst.object);
        const externSig =
          resolveExternSignature(
            objectTypeName,
            setInst.property,
            "setter",
            tsParamTypes,
            "void",
          ) ??
          createUdonExternSignature(
            `set_${setInst.property}`,
            paramTypes,
            "Void",
          );
        this.externSignatures.add(externSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(externSig), true),
        );
        break;
      }

      case TACInstructionKind.ArrayAccess: {
        const arrayInst = inst as unknown as {
          dest: TACOperand;
          array: TACOperand;
          index: TACOperand;
        };
        this.pushOperand(arrayInst.array);
        this.pushOperand(arrayInst.index);
        const externSig = "SystemArray.__Get__SystemInt32__SystemObject";
        this.externSignatures.add(externSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(externSig), true),
        );
        const destAddr = this.getOperandAddress(arrayInst.dest);
        this.instructions.push(new PushInstruction(destAddr));
        this.instructions.push(new CopyInstruction());
        break;
      }

      case TACInstructionKind.ArrayAssignment: {
        const arrayInst = inst as unknown as {
          array: TACOperand;
          index: TACOperand;
          value: TACOperand;
        };
        this.pushOperand(arrayInst.array);
        this.pushOperand(arrayInst.index);
        this.pushOperand(arrayInst.value);
        const externSig =
          "SystemArray.__Set__SystemInt32_SystemObject__SystemVoid";
        this.externSignatures.add(externSig);
        this.instructions.push(
          new ExternInstruction(this.getExternSymbol(externSig), true),
        );
        break;
      }

      case TACInstructionKind.Return: {
        const retInst = inst as TACReturnInstruction;
        if (retInst.value) {
          this.pushOperand(retInst.value);
          const returnVar = retInst.returnVarName ?? "__returnValue_return";
          this.getReturnValueAddress(returnVar);
          this.instructions.push(new PushInstruction(returnVar));
          this.instructions.push(new CopyInstruction());
        }

        // Jump to exit address directly (0xFFFFFFFC)
        this.instructions.push(new JumpInstruction("0xFFFFFFFC"));
        break;
      }
    }
  }

  /**
   * Push operand onto stack
   */
  private pushOperand(operand: TACOperand): void {
    const addr = this.getOperandAddress(operand);
    this.instructions.push(new PushInstruction(addr));
  }

  /**
   * Get or allocate address for operand
   */
  private getOperandAddress(operand: TACOperand): number | string {
    switch (operand.kind) {
      case TACOperandKind.Variable: {
        const varOp = operand as VariableOperand;
        const normalizedName = this.normalizeVariableName(varOp.name);
        if (!this.variableAddresses.has(normalizedName)) {
          this.variableAddresses.set(normalizedName, this.nextAddress++);
          this.variableTypes.set(normalizedName, varOp.type.udonType);
        }
        // Return the variable name for use in PUSH instruction
        return normalizedName;
      }

      case TACOperandKind.Temporary: {
        const tempOp = operand as TemporaryOperand;
        if (!this.tempAddresses.has(tempOp.id)) {
          this.tempAddresses.set(tempOp.id, this.nextAddress++);
          this.tempTypes.set(tempOp.id, tempOp.type.udonType);
        }
        // Return the temporary name for use in PUSH instruction
        return `__t${tempOp.id}`;
      }

      case TACOperandKind.Constant: {
        const constOp = operand as ConstantOperand;
        const key = this.getConstantKey(constOp.value, constOp.type.udonType);
        if (!this.constantAddresses.has(key)) {
          const addr = this.nextAddress++;
          this.constantAddresses.set(key, addr);
          this.constantTypes.set(key, constOp.type.udonType);
        }
        // Return the constant variable name for use in PUSH instruction
        const addr = this.constantAddresses.get(key) as number;
        const type = this.constantTypes.get(key) ?? "Single";
        return `__const_${addr}_System${type}`;
      }

      case TACOperandKind.Label: {
        const labelOp = operand as LabelOperand;
        return labelOp.name;
      }

      default:
        throw new Error(`Unknown operand kind: ${operand.kind}`);
    }
  }

  /**
   * Get operand type name for extern signatures
   */
  private getOperandTypeName(operand: TACOperand): string {
    switch (operand.kind) {
      case TACOperandKind.Variable:
      case TACOperandKind.Constant:
      case TACOperandKind.Temporary: {
        const type =
          (operand as { type?: { udonType?: string } }).type?.udonType ??
          "Object";
        return `System${type}`;
      }
      default:
        return "SystemObject";
    }
  }

  private getOperandUdonType(operand: TACOperand): string {
    switch (operand.kind) {
      case TACOperandKind.Variable:
      case TACOperandKind.Constant:
      case TACOperandKind.Temporary:
        return (
          (operand as { type?: { udonType?: string } }).type?.udonType ??
          "Object"
        );
      default:
        return "Object";
    }
  }

  private getConstantKey(value: unknown, typeName: string): string {
    if (typeof value === "bigint") {
      return `${typeName}|bigint:${value.toString()}`;
    }
    return `${typeName}|${JSON.stringify(value)}`;
  }

  private normalizeVariableName(name: string): string {
    if (name === "this") {
      return "__this";
    }
    return name;
  }

  getHeapUsageByClass(): Map<string, number> {
    const usage = new Map<string, number>();
    const increment = (className: string, count = 1) => {
      usage.set(className, (usage.get(className) ?? 0) + count);
    };
    const defaultClass = this.entryClassName ?? "<global>";

    const variableNames = Array.from(this.variableAddresses.keys());
    const pushVariableNames = (names: string[]) => {
      for (const name of names) {
        if (name === "__this") {
          increment(defaultClass);
          continue;
        }
        if (name.startsWith("__inst_")) {
          const className = this.extractInlineClassName(name);
          if (className) {
            increment(className);
            continue;
          }
        }
        if (this.inlineClassNames.size > 0) {
          let matched = false;
          for (const className of this.inlineClassNames) {
            if (name === className || name.startsWith(`${className}_`)) {
              increment(className);
              matched = true;
              break;
            }
          }
          if (matched) {
            continue;
          }
        }
        if (name.startsWith("__t") || name.startsWith("__const_")) {
          increment("<temporary>");
          continue;
        }
        if (name.startsWith("__")) {
          increment(defaultClass);
          continue;
        }
        increment(defaultClass);
      }
    };

    pushVariableNames(variableNames);
    for (const _name of this.tempAddresses.keys()) {
      increment("<temporary>");
    }
    if (this.constantAddresses.size > 0) {
      increment("<temporary>", this.constantAddresses.size);
    }
    if (this.externSymbolBySignature.size > 0) {
      increment("<extern>", this.externSymbolBySignature.size);
    }

    return usage;
  }

  private extractInlineClassName(name: string): string | null {
    if (!name.startsWith("__inst_")) {
      return null;
    }
    const rest = name.slice("__inst_".length);
    const parts = rest.split("_").filter((part) => part.length > 0);
    const numericIndex = parts.findIndex((part) =>
      TACToUdonConverter.digitOnlyPattern.test(part),
    );
    if (numericIndex > 0) {
      return parts.slice(0, numericIndex).join("_");
    }
    if (numericIndex === 0) {
      return null;
    }
    return parts.join("_") || null;
  }

  private parseConstantKey(key: string): unknown {
    const payload = this.getConstantKeyPayload(key);
    if (payload.startsWith("bigint:")) {
      return BigInt(payload.slice("bigint:".length));
    }
    return JSON.parse(payload);
  }

  private getConstantKeyPayload(key: string): string {
    const sep = key.indexOf("|");
    if (sep === -1) {
      return key;
    }
    return key.slice(sep + 1);
  }

  private formatInt64HexConstant(key: string, rawValue: unknown): string {
    let value: bigint;

    const payload = this.getConstantKeyPayload(key);

    if (payload.startsWith("bigint:")) {
      value = BigInt(payload.slice("bigint:".length));
    } else if (typeof rawValue === "string") {
      if (rawValue.startsWith("0x") || rawValue.startsWith("0X")) {
        return rawValue;
      }
      value = BigInt(rawValue);
    } else if (typeof rawValue === "number") {
      // Use the numeric value directly; parsing the key is fragile
      // (key can be JSON for objects/arrays). Always truncate to
      // integer part and convert to BigInt.
      value = BigInt(Math.trunc(rawValue));
    } else if (typeof rawValue === "bigint") {
      value = rawValue;
    } else {
      value = 0n;
    }

    const mask = (1n << 64n) - 1n;
    const normalized = value & mask;
    const hex = normalized.toString(16).toUpperCase().padStart(16, "0");
    return `0x${hex}`;
  }

  private isFloatType(typeName: string): boolean {
    return typeName === "Single" || typeName === "Double";
  }

  private isIntegerType(typeName: string): boolean {
    return (
      typeName === "Byte" ||
      typeName === "SByte" ||
      typeName === "Int16" ||
      typeName === "UInt16" ||
      typeName === "Int32" ||
      typeName === "UInt32" ||
      typeName === "Int64" ||
      typeName === "UInt64"
    );
  }

  private getConvertExternSignature(
    sourceType: string,
    targetType: string,
  ): string {
    const method = this.getConvertMethodName(targetType);
    return `SystemConvert.__${method}__System${sourceType}__System${targetType}`;
  }

  private getConvertMethodName(targetType: string): string {
    switch (targetType) {
      case "Int16":
        return "ToInt16";
      case "UInt16":
        return "ToUInt16";
      case "Int32":
        return "ToInt32";
      case "UInt32":
        return "ToUInt32";
      case "Int64":
        return "ToInt64";
      case "UInt64":
        return "ToUInt64";
      case "Single":
        return "ToSingle";
      case "Double":
        return "ToDouble";
      case "Boolean":
        return "ToBoolean";
      default:
        throw new Error(`Unsupported cast target type: ${targetType}`);
    }
  }

  private getTruncateExternSignature(): string {
    return "SystemMath.__Truncate__SystemDouble__SystemDouble";
  }

  private getOperandTsTypeName(operand: TACOperand): string {
    switch (operand.kind) {
      case TACOperandKind.Variable:
      case TACOperandKind.Constant:
      case TACOperandKind.Temporary: {
        const typeName =
          (operand as { type?: { name?: string } }).type?.name ?? "object";
        return typeName;
      }
      default:
        return "object";
    }
  }

  /**
   * Get extern signature for binary operation
   */
  private getExternForBinaryOp(operator: string, typeStr: string): string {
    let methodName: string;
    let returnType = typeStr;

    switch (operator) {
      case "+":
        methodName = "op_Addition";
        break;
      case "-":
        methodName = "op_Subtraction";
        break;
      case "*":
        methodName = "op_Multiply";
        break;
      case "/":
        methodName = "op_Division";
        break;
      case "%":
        methodName = "op_Remainder";
        break;
      case "<":
        methodName = "op_LessThan";
        returnType = "Boolean";
        break;
      case ">":
        methodName = "op_GreaterThan";
        returnType = "Boolean";
        break;
      case "<=":
        methodName = "op_LessThanOrEqual";
        returnType = "Boolean";
        break;
      case ">=":
        methodName = "op_GreaterThanOrEqual";
        returnType = "Boolean";
        break;
      case "==":
        methodName = "op_Equality";
        returnType = "Boolean";
        break;
      case "!=":
        methodName = "op_Inequality";
        returnType = "Boolean";
        break;
      case "&":
        methodName = "op_LogicalAnd";
        break;
      case "|":
        methodName = "op_LogicalOr";
        break;
      case "^":
        methodName = "op_LogicalXor";
        break;
      case "<<":
        methodName = "op_LeftShift";
        break;
      case ">>":
        methodName = "op_RightShift";
        break;
      default:
        throw new Error(`Unsupported binary operator: ${operator}`);
    }

    return createUdonExternSignature(
      methodName,
      [typeStr, typeStr],
      returnType,
    );
  }

  /**
   * Get extern signature for unary operation
   */
  private getExternForUnaryOp(operator: string, operandType: string): string {
    let methodName: string;

    switch (operator) {
      case "-":
        methodName = "op_UnaryMinus";
        break;
      case "!":
        methodName = "op_UnaryNegation";
        operandType = "Boolean"; // ! operator is always on Boolean
        break;
      default:
        throw new Error(`Unsupported unary operator: ${operator}`);
    }

    return createUdonExternSignature(methodName, [operandType], operandType);
  }

  /**
   * Get variable and constant data
   */
  getDataSection(): Map<string, number> {
    const entries: [string, number][] = [];

    for (const [signature, symbol] of this.externSymbolBySignature) {
      const addr = this.externAddressBySignature.get(signature);
      if (addr !== undefined) entries.push([symbol, addr]);
    }

    entries.push(
      ...Array.from(this.variableAddresses.entries()),
      ...Array.from(this.tempAddresses.entries()).map(
        ([id, addr]): [string, number] => [`__t${id}`, addr],
      ),
      ...Array.from(this.constantAddresses.entries()),
    );
    return new Map(entries);
  }

  /**
   * Get data section with types for proper .uasm generation
   * Returns array of [name, address, type, value]
   */
  getDataSectionWithTypes(): Array<[string, number, string, unknown]> {
    const entries: Array<[string, number, string, unknown]> = [];

    // Extern signatures (interned)
    for (const [signature, symbol] of this.externSymbolBySignature) {
      const addr = this.externAddressBySignature.get(signature);
      if (addr === undefined) continue;
      entries.push([symbol, addr, "String", signature]);
    }

    // Variables
    for (const [name, addr] of this.variableAddresses) {
      const type = this.variableTypes.get(name) ?? "Single";
      const value: unknown = null;
      entries.push([name, addr, type, value]);
    }

    // Temporaries
    for (const [id, addr] of this.tempAddresses) {
      const name = `__t${id}`;
      const type = this.tempTypes.get(id) ?? "Single";
      entries.push([name, addr, type, null]);
    }

    // Constants
    for (const [key, addr] of this.constantAddresses) {
      const type = this.constantTypes.get(key) ?? "Single";
      const rawValue = this.parseConstantKey(key);
      let value = rawValue;
      if (type === "Int64" || type === "UInt64") {
        value = this.formatInt64HexConstant(key, rawValue);
      }
      // Create a unique name for constants
      const name = `__const_${addr}_System${type}`;
      entries.push([name, addr, type, value]);
    }

    return entries;
  }

  private getReturnValueAddress(name: string): void {
    const normalizedName = this.normalizeVariableName(name);
    if (!this.variableAddresses.has(normalizedName)) {
      this.variableAddresses.set(normalizedName, this.nextAddress++);
      this.variableTypes.set(normalizedName, "Object");
    }
  }
}

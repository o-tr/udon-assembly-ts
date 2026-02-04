/**
 * TAC (Three-Address Code) instruction definitions
 */

import type { TACOperand } from "./tac_operand.js";
import { operandToString } from "./tac_operand.js";

/**
 * TAC instruction kinds
 */
export enum TACInstructionKind {
  Assignment = "Assignment",
  BinaryOp = "BinaryOp",
  UnaryOp = "UnaryOp",
  Copy = "Copy",
  Cast = "Cast",
  ConditionalJump = "ConditionalJump",
  UnconditionalJump = "UnconditionalJump",
  Label = "Label",
  Call = "Call",
  MethodCall = "MethodCall",
  PropertyGet = "PropertyGet",
  PropertySet = "PropertySet",
  Return = "Return",
  ArrayAccess = "ArrayAccess",
  ArrayAssignment = "ArrayAssignment",
}

/**
 * Base TAC instruction
 */
export interface TACInstruction {
  kind: TACInstructionKind;
  toString(): string;
}

/**
 * Assignment: dest = src
 */
export class AssignmentInstruction implements TACInstruction {
  kind = TACInstructionKind.Assignment as const;

  constructor(
    public dest: TACOperand,
    public src: TACOperand,
  ) {}

  toString(): string {
    return `${operandToString(this.dest)} = ${operandToString(this.src)}`;
  }
}

/**
 * Binary operation: dest = left op right
 */
export class BinaryOpInstruction implements TACInstruction {
  kind = TACInstructionKind.BinaryOp as const;

  constructor(
    public dest: TACOperand,
    public left: TACOperand,
    public operator: string,
    public right: TACOperand,
  ) {}

  toString(): string {
    return `${operandToString(this.dest)} = ${operandToString(this.left)} ${this.operator} ${operandToString(this.right)}`;
  }
}

/**
 * Unary operation: dest = op operand
 */
export class UnaryOpInstruction implements TACInstruction {
  kind = TACInstructionKind.UnaryOp as const;

  constructor(
    public dest: TACOperand,
    public operator: string,
    public operand: TACOperand,
  ) {}

  toString(): string {
    return `${operandToString(this.dest)} = ${this.operator}${operandToString(this.operand)}`;
  }
}

/**
 * Copy: dest = src (alias for assignment)
 */
export class CopyInstruction implements TACInstruction {
  kind = TACInstructionKind.Copy as const;

  constructor(
    public dest: TACOperand,
    public src: TACOperand,
  ) {}

  toString(): string {
    return `${operandToString(this.dest)} = ${operandToString(this.src)}`;
  }
}

/**
 * Cast: dest = (type) src
 */
export class CastInstruction implements TACInstruction {
  kind = TACInstructionKind.Cast as const;

  constructor(
    public dest: TACOperand,
    public src: TACOperand,
  ) {}

  toString(): string {
    return `${operandToString(this.dest)} = cast ${operandToString(this.src)}`;
  }
}

/**
 * Conditional jump: if condition is false goto label
 */
export class ConditionalJumpInstruction implements TACInstruction {
  kind = TACInstructionKind.ConditionalJump as const;

  constructor(
    public condition: TACOperand,
    public label: TACOperand,
  ) {}

  toString(): string {
    return `ifFalse ${operandToString(this.condition)} goto ${operandToString(this.label)}`;
  }
}

/**
 * Unconditional jump: goto label
 */
export class UnconditionalJumpInstruction implements TACInstruction {
  kind = TACInstructionKind.UnconditionalJump as const;

  constructor(public label: TACOperand) {}

  toString(): string {
    return `goto ${operandToString(this.label)}`;
  }
}

/**
 * Label marker
 */
export class LabelInstruction implements TACInstruction {
  kind = TACInstructionKind.Label as const;

  constructor(public label: TACOperand) {}

  toString(): string {
    return `${operandToString(this.label)}:`;
  }
}

/**
 * Function call: dest = call func(args...)
 */
export class CallInstruction implements TACInstruction {
  kind = TACInstructionKind.Call as const;

  constructor(
    public dest: TACOperand | undefined,
    public func: string,
    public args: TACOperand[],
  ) {}

  toString(): string {
    const argsStr = this.args.map(operandToString).join(", ");
    if (this.dest) {
      return `${operandToString(this.dest)} = call ${this.func}(${argsStr})`;
    }
    return `call ${this.func}(${argsStr})`;
  }
}

/**
 * Method call: dest = obj.method(args...)
 */
export class MethodCallInstruction implements TACInstruction {
  kind = TACInstructionKind.MethodCall as const;

  constructor(
    public dest: TACOperand | undefined,
    public object: TACOperand,
    public method: string,
    public args: TACOperand[],
  ) {}

  toString(): string {
    const argsStr = this.args.map(operandToString).join(", ");
    if (this.dest) {
      return `${operandToString(this.dest)} = call ${operandToString(this.object)}.${this.method}(${argsStr})`;
    }
    return `call ${operandToString(this.object)}.${this.method}(${argsStr})`;
  }
}

/**
 * Property get: dest = obj.prop
 */
export class PropertyGetInstruction implements TACInstruction {
  kind = TACInstructionKind.PropertyGet as const;

  constructor(
    public dest: TACOperand,
    public object: TACOperand,
    public property: string,
  ) {}

  toString(): string {
    return `${operandToString(this.dest)} = ${operandToString(this.object)}.${this.property}`;
  }
}

/**
 * Property set: obj.prop = value
 */
export class PropertySetInstruction implements TACInstruction {
  kind = TACInstructionKind.PropertySet as const;

  constructor(
    public object: TACOperand,
    public property: string,
    public value: TACOperand,
  ) {}

  toString(): string {
    return `${operandToString(this.object)}.${this.property} = ${operandToString(this.value)}`;
  }
}

/**
 * Return statement: return value
 */
export class ReturnInstruction implements TACInstruction {
  kind = TACInstructionKind.Return as const;

  constructor(
    public value?: TACOperand,
    public returnVarName?: string,
  ) {}

  toString(): string {
    if (this.value) {
      return `return ${operandToString(this.value)}`;
    }
    return "return";
  }
}

/**
 * Array access: dest = array[index]
 */
export class ArrayAccessInstruction implements TACInstruction {
  kind = TACInstructionKind.ArrayAccess as const;

  constructor(
    public dest: TACOperand,
    public array: TACOperand,
    public index: TACOperand,
  ) {}

  toString(): string {
    return `${operandToString(this.dest)} = ${operandToString(this.array)}[${operandToString(this.index)}]`;
  }
}

/**
 * Array assignment: array[index] = value
 */
export class ArrayAssignmentInstruction implements TACInstruction {
  kind = TACInstructionKind.ArrayAssignment as const;

  constructor(
    public array: TACOperand,
    public index: TACOperand,
    public value: TACOperand,
  ) {}

  toString(): string {
    return `${operandToString(this.array)}[${operandToString(this.index)}] = ${operandToString(this.value)}`;
  }
}

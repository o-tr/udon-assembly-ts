/**
 * Udon Assembly instruction types
 */

/**
 * Udon instruction kinds
 */
export enum UdonInstructionKind {
  Push = "PUSH",
  Pop = "POP",
  Copy = "COPY",
  Extern = "EXTERN",
  Jump = "JUMP",
  JumpIfFalse = "JUMP_IF_FALSE",
  JumpIndirect = "JUMP_INDIRECT",
  Label = "LABEL",
}

/**
 * Base Udon instruction
 */
export interface UdonInstruction {
  kind: UdonInstructionKind;
  size: number; // Size in bytes
  toString(): string;
}

/**
 * PUSH instruction - push value onto stack
 */
export class PushInstruction implements UdonInstruction {
  kind = UdonInstructionKind.Push as const;
  size = 8; // PUSH instruction is 8 bytes

  constructor(public address: number | string) {}

  toString(): string {
    return `    PUSH, ${this.address}`;
  }
}

/**
 * POP instruction - pop value from stack
 */
export class PopInstruction implements UdonInstruction {
  kind = UdonInstructionKind.Pop as const;
  size = 4; // POP instruction is 4 bytes

  toString(): string {
    return "    POP";
  }
}

/**
 * COPY instruction - copy top of stack to address
 */
export class CopyInstruction implements UdonInstruction {
  kind = UdonInstructionKind.Copy as const;
  size = 4; // COPY instruction is 4 bytes

  toString(): string {
    return "    COPY";
  }
}

/**
 * EXTERN instruction - call external function
 */
export class ExternInstruction implements UdonInstruction {
  kind = UdonInstructionKind.Extern as const;
  size = 8; // EXTERN instruction is 8 bytes

  constructor(
    public signature: string,
    public isSymbol = false,
  ) {}

  toString(): string {
    const operand = this.isSymbol ? this.signature : `"${this.signature}"`;
    return `    EXTERN, ${operand}`;
  }
}

/**
 * JUMP instruction - unconditional jump to address
 */
export class JumpInstruction implements UdonInstruction {
  kind = UdonInstructionKind.Jump as const;
  size = 8; // JUMP instruction is 8 bytes

  constructor(public address: number | string) {}

  toString(): string {
    return `    JUMP, ${this.address}`;
  }
}

/**
 * JUMP_IF_FALSE instruction - jump if top of stack is false
 */
export class JumpIfFalseInstruction implements UdonInstruction {
  kind = UdonInstructionKind.JumpIfFalse as const;
  size = 8; // JUMP_IF_FALSE instruction is 8 bytes

  constructor(public address: number | string) {}

  toString(): string {
    return `    JUMP_IF_FALSE, ${this.address}`;
  }
}

/**
 * JUMP_INDIRECT instruction - jump to address stored in variable
 */
export class JumpIndirectInstruction implements UdonInstruction {
  kind = UdonInstructionKind.JumpIndirect as const;
  size = 8; // JUMP_INDIRECT instruction is 8 bytes

  constructor(public address: number | string) {}

  toString(): string {
    return `    JUMP_INDIRECT, ${this.address}`;
  }
}

/**
 * Label marker (converted to address in final output)
 */
export class LabelInstruction implements UdonInstruction {
  kind = UdonInstructionKind.Label as const;
  size = 0; // Labels don't take space in bytecode

  constructor(public name: string) {}

  toString(): string {
    return `${this.name}:`;
  }
}

/**
 * Helper to create extern signature
 */
export function createExternSignature(
  funcName: string,
  params: string[],
  returnType?: string,
): string {
  const paramsStr = params.join(", ");
  if (returnType) {
    return `${funcName}(${paramsStr}) -> ${returnType}`;
  }
  return `${funcName}(${paramsStr})`;
}

/**
 * Sanitize type name for Udon (remove dots, handle special cases)
 */
export function sanitizeTypeName(typeName: string): string {
  // Remove 'System.' prefix only at the beginning
  let sanitized = typeName.replace(/^System\./, "System");

  // Remove any remaining dots
  sanitized = sanitized.replace(/\./g, "");

  // Handle array notation
  sanitized = sanitized.replace(/\[\]/g, "Array");

  // Handle reference notation
  sanitized = sanitized.replace(/&/g, "Ref");

  return sanitized;
}

/**
 * Create UdonSharp SDK compatible extern signature
 * Format: {Type}.__{MethodName}__{Param1}_{Param2}__...__{ReturnType}
 */
export function createUdonExternSignature(
  methodName: string,
  params: string[],
  returnType: string,
): string {
  // For operators, the type is the first parameter's type
  const baseType = params.length > 0 ? sanitizeTypeName(params[0]) : "System";

  // Sanitize all parameter types
  const sanitizedParams = params.map(sanitizeTypeName);
  const sanitizedReturn = sanitizeTypeName(returnType);

  // Build signature: Type.__MethodName__Param1_Param2__ReturnType
  const paramsPart = sanitizedParams.join("_");
  return `${baseType}.__${methodName}__${paramsPart}__${sanitizedReturn}`;
}

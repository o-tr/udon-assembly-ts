/**
 * Udon Assembly (.uasm) file generator
 */

import { isVrcEventLabel } from "../vrc/event_registry.js";
import type { UdonInstruction } from "./udon_instruction.js";
import {
  type JumpIfFalseInstruction,
  type JumpInstruction,
  type LabelInstruction,
  type PushInstruction,
  UdonInstructionKind,
} from "./udon_instruction.js";
import {
  mapTypeScriptToCSharp,
  toUdonTypeNameWithArray,
} from "./udon_type_resolver.js";

/**
 * Udon assembler - generates .uasm output
 */
export class UdonAssembler {
  private expandExponentialLiteral(text: string): string {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
    if (!match) {
      return text;
    }

    const sign = match[1] ?? "";
    const integerPart = match[2] ?? "0";
    const fractionPart = match[3] ?? "";
    const exponent = Number(match[4]);

    const digits = `${integerPart}${fractionPart}`;
    const integerLength = integerPart.length;
    const decimalIndex = integerLength + exponent;

    if (decimalIndex <= 0) {
      const zeros = "0".repeat(-decimalIndex);
      return `${sign}0.${zeros}${digits}`;
    }

    if (decimalIndex >= digits.length) {
      const zeros = "0".repeat(decimalIndex - digits.length);
      return `${sign}${digits}${zeros}`;
    }

    return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }

  private formatFloatLiteral(value: number): string {
    if (!Number.isFinite(value)) {
      return JSON.stringify(value);
    }

    const text = value.toString();
    const expanded =
      text.includes("e") || text.includes("E")
        ? this.expandExponentialLiteral(text)
        : text;

    if (expanded.includes(".")) {
      return expanded;
    }

    return `${expanded}.0`;
  }

  private isFloatType(typeName: string): boolean {
    return (
      typeName === "Single" ||
      typeName === "Double" ||
      typeName === "SystemSingle" ||
      typeName === "SystemDouble" ||
      typeName === "System.Single" ||
      typeName === "System.Double"
    );
  }

  private isIntegerType(typeName: string): boolean {
    return (
      typeName === "Byte" ||
      typeName === "SByte" ||
      typeName === "Int16" ||
      typeName === "UInt16" ||
      typeName === "Int32" ||
      typeName === "UInt32" ||
      typeName === "SystemByte" ||
      typeName === "SystemSByte" ||
      typeName === "SystemInt16" ||
      typeName === "SystemUInt16" ||
      typeName === "SystemInt32" ||
      typeName === "SystemUInt32" ||
      typeName === "System.Byte" ||
      typeName === "System.SByte" ||
      typeName === "System.Int16" ||
      typeName === "System.UInt16" ||
      typeName === "System.Int32" ||
      typeName === "System.UInt32"
    );
  }

  private isUInt32Type(typeName: string): boolean {
    return (
      typeName === "UInt32" ||
      typeName === "SystemUInt32" ||
      typeName === "System.UInt32"
    );
  }

  private getIntegerBounds(
    typeName: string,
  ): { min: number; max: number } | null {
    switch (typeName) {
      case "Byte":
      case "SystemByte":
      case "System.Byte":
        return { min: 0, max: 255 };
      case "SByte":
      case "SystemSByte":
      case "System.SByte":
        return { min: -128, max: 127 };
      case "Int16":
      case "SystemInt16":
      case "System.Int16":
        return { min: -32768, max: 32767 };
      case "UInt16":
      case "SystemUInt16":
      case "System.UInt16":
        return { min: 0, max: 65535 };
      case "Int32":
      case "SystemInt32":
      case "System.Int32":
        return { min: -2147483648, max: 2147483647 };
      case "UInt32":
      case "SystemUInt32":
      case "System.UInt32":
        return { min: 0, max: 4294967295 };
      default:
        return null;
    }
  }

  private formatIntegerLiteral(value: number, typeName: string): string {
    if (!Number.isFinite(value)) {
      return JSON.stringify(value);
    }

    let truncated = Math.trunc(value);
    if (this.isUInt32Type(typeName) && truncated < 0) {
      const text = truncated.toString();
      const expanded =
        text.includes("e") || text.includes("E")
          ? this.expandExponentialLiteral(text)
          : text;
      return expanded.includes(".") ? expanded.split(".")[0] : expanded;
    }
    const bounds = this.getIntegerBounds(typeName);
    if (bounds) {
      if (truncated < bounds.min) {
        truncated = bounds.min;
      } else if (truncated > bounds.max) {
        truncated = bounds.max;
      }
    }

    const text = truncated.toString();
    const expanded =
      text.includes("e") || text.includes("E")
        ? this.expandExponentialLiteral(text)
        : text;

    return expanded.includes(".") ? expanded.split(".")[0] : expanded;
  }

  private isStringType(typeName: string): boolean {
    return (
      typeName === "String" ||
      typeName === "SystemString" ||
      typeName === "System.String"
    );
  }

  private isBooleanType(typeName: string): boolean {
    return (
      typeName === "Boolean" ||
      typeName === "SystemBoolean" ||
      typeName === "System.Boolean"
    );
  }

  private resolveUdonTypeName(typeName: string): string {
    const csharpType = mapTypeScriptToCSharp(typeName);
    if (
      csharpType === typeName &&
      !typeName.includes(".") &&
      !typeName.startsWith("System")
    ) {
      return toUdonTypeNameWithArray(`System.${typeName}`);
    }
    return toUdonTypeNameWithArray(csharpType);
  }

  /**
   * Format byte address as hex string
   */
  private formatHexAddress(byteAddr: number): string {
    return `0x${byteAddr.toString(16).toUpperCase().padStart(8, "0")}`;
  }

  /**
   * Generate .uasm file content
   */
  assemble(
    instructions: UdonInstruction[],
    _externSignatures: string[],
    dataSection?: Array<[string, number, string, unknown]>,
    syncModes?: Map<string, string>,
    _behaviourSyncMode?: string,
    exportLabels?: Set<string>,
  ): string {
    const lines: string[] = [];

    // Data section
    lines.push(".data_start");
    lines.push("");

    // Data definitions (variables and constants)
    if (dataSection && dataSection.length > 0) {
      // Sort by address to ensure consistent output
      const sortedData = [...dataSection].sort((a, b) => a[1] - b[1]);

      for (const [name, _address, type, value] of sortedData) {
        // Variable declaration: name: %Type, initialValue
        const csharpType = mapTypeScriptToCSharp(type);
        const udonType = this.resolveUdonTypeName(type);

        const resolvedValue = value;

        let initialValue: string;
        const isBoolean =
          this.isBooleanType(type) ||
          this.isBooleanType(csharpType) ||
          this.isBooleanType(udonType);

        if (resolvedValue === null) {
          initialValue = "null";
        } else if (isBoolean) {
          initialValue = resolvedValue === true ? "true" : "false";
        } else if (
          udonType === "SystemType" &&
          typeof resolvedValue === "string"
        ) {
          initialValue = resolvedValue;
        } else if (
          typeof resolvedValue === "string" &&
          resolvedValue.startsWith("0x") &&
          !this.isStringType(type) &&
          !this.isStringType(csharpType) &&
          !this.isStringType(udonType)
        ) {
          initialValue = resolvedValue;
        } else if (
          typeof resolvedValue === "number" &&
          (this.isFloatType(type) ||
            this.isFloatType(csharpType) ||
            this.isFloatType(udonType))
        ) {
          initialValue = this.formatFloatLiteral(resolvedValue);
        } else if (
          typeof resolvedValue === "number" &&
          (this.isIntegerType(type) ||
            this.isIntegerType(csharpType) ||
            this.isIntegerType(udonType))
        ) {
          const integerTypeName = this.isIntegerType(udonType)
            ? udonType
            : this.isIntegerType(csharpType)
              ? csharpType
              : type;
          initialValue = this.formatIntegerLiteral(
            resolvedValue,
            integerTypeName,
          );
        } else {
          initialValue = JSON.stringify(resolvedValue);
        }

        lines.push(`    ${name}: %${udonType}, ${initialValue}`);

        // internal variables should not be exported or synced
        if (!name.startsWith("__")) {
          lines.push(`    .export ${name}`);
          const syncMode = syncModes?.get(name);
          lines.push(`    .sync ${name}, ${syncMode ?? "none"}`);
        }
      }
      lines.push("");
    }

    lines.push(".data_end");
    lines.push("");

    // Code section
    lines.push(".code_start");
    lines.push("");

    // Removed emission of the behaviour sync mode directive
    // behaviourSyncMode directive intentionally omitted
    // Resolve labels to byte addresses and canonical labels
    const { labelAddresses, canonicalLabels } = this.computeLabelAddressInfo(
      instructions,
      exportLabels,
    );

    // Convert instructions to text, replacing label references with addresses
    for (const inst of instructions) {
      if (inst.kind === UdonInstructionKind.Label) {
        // Labels appear on their own line
        const labelName = (inst as LabelInstruction).name;
        const canonicalLabel = canonicalLabels.get(labelName) ?? labelName;
        if (canonicalLabel !== labelName) {
          continue;
        }
        if (labelName === "_start") {
          lines.push("    .export _start");
        } else if (isVrcEventLabel(labelName)) {
          lines.push(`    .export ${labelName}`);
        } else if (exportLabels?.has(labelName)) {
          lines.push(`    .export ${labelName}`);
        }
        lines.push(inst.toString());
      } else if (inst.kind === UdonInstructionKind.Jump) {
        const jumpInst = inst as JumpInstruction;
        if (typeof jumpInst.address === "string") {
          // Replace label with byte address
          const canonicalLabel =
            canonicalLabels.get(jumpInst.address) ?? jumpInst.address;
          const byteAddr = labelAddresses.get(canonicalLabel);
          if (byteAddr !== undefined) {
            lines.push(`    JUMP, ${this.formatHexAddress(byteAddr)}`);
          } else {
            lines.push(inst.toString());
          }
        } else {
          lines.push(inst.toString());
        }
      } else if (inst.kind === UdonInstructionKind.JumpIfFalse) {
        const jumpInst = inst as JumpIfFalseInstruction;
        if (typeof jumpInst.address === "string") {
          // Replace label with byte address
          const canonicalLabel =
            canonicalLabels.get(jumpInst.address) ?? jumpInst.address;
          const byteAddr = labelAddresses.get(canonicalLabel);
          if (byteAddr !== undefined) {
            lines.push(`    JUMP_IF_FALSE, ${this.formatHexAddress(byteAddr)}`);
          } else {
            lines.push(inst.toString());
          }
        } else {
          lines.push(inst.toString());
        }
      } else if (inst.kind === UdonInstructionKind.Push) {
        const _pushInst = inst as PushInstruction;
        // If address is a variable name from data section, keep it as-is
        // Otherwise convert to address
        lines.push(inst.toString());
      } else {
        lines.push(inst.toString());
      }
    }

    lines.push("");
    lines.push(".code_end");

    return lines.join("\n");
  }

  /**
   * Compute byte addresses for labels and canonicalize labels sharing addresses.
   */
  private computeLabelAddressInfo(
    instructions: UdonInstruction[],
    exportLabels?: Set<string>,
  ): {
    labelAddresses: Map<string, number>;
    canonicalLabels: Map<string, string>;
  } {
    const labelAddresses = new Map<string, number>();
    const labelsByAddress = new Map<number, string[]>();
    let byteAddress = 0;

    for (const inst of instructions) {
      if (inst.kind === UdonInstructionKind.Label) {
        const label = inst as LabelInstruction;
        labelAddresses.set(label.name, byteAddress);
        const labelsAtAddress = labelsByAddress.get(byteAddress);
        if (labelsAtAddress) {
          labelsAtAddress.push(label.name);
        } else {
          labelsByAddress.set(byteAddress, [label.name]);
        }
      } else {
        // Add instruction size in bytes
        byteAddress += inst.size;
      }
    }

    const canonicalLabels = new Map<string, string>();
    for (const labels of labelsByAddress.values()) {
      const canonical = this.pickCanonicalLabel(labels, exportLabels);
      for (const label of labels) {
        canonicalLabels.set(label, canonical);
      }
    }

    return { labelAddresses, canonicalLabels };
  }

  private pickCanonicalLabel(
    labels: string[],
    exportLabels?: Set<string>,
  ): string {
    let canonical = labels[0];
    let bestScore = this.getLabelPriority(canonical, exportLabels);

    for (const label of labels) {
      const score = this.getLabelPriority(label, exportLabels);
      if (score > bestScore) {
        canonical = label;
        bestScore = score;
      }
    }

    return canonical;
  }

  private getLabelPriority(label: string, exportLabels?: Set<string>): number {
    if (isVrcEventLabel(label)) {
      return 3;
    }
    if (label === "_start") {
      return 2;
    }
    if (exportLabels?.has(label)) {
      return 1;
    }
    return 0;
  }
}

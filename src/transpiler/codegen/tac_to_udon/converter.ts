/**
 * Convert TAC to Udon Assembly instructions
 */

import type { TACInstruction } from "../../ir/tac_instruction.js";
import type { UdonInstruction } from "../udon_instruction.js";
import {
  formatInt64HexConstant,
  getConstantKey,
  getConstantKeyPayload,
  parseConstantKey,
} from "./constants.js";
import { convertInstruction } from "./convert_instruction.js";
import {
  getConvertExternSignature,
  getConvertMethodName,
  getExternForBinaryOp,
  getExternForUnaryOp,
  getExternSymbol,
  getTruncateExternSignature,
} from "./externs.js";
import {
  getOperandAddress,
  getOperandTypeName,
  getOperandUdonType,
  getReturnValueAddress,
  normalizeVariableName,
  pushOperand,
} from "./operands.js";
import {
  extractInlineClassName,
  getOperandTsTypeName,
  isFloatType,
  isIntegerType,
  mapUdonTypeToTs,
} from "./types.js";

/**
 * TAC to Udon converter
 */
export class TACToUdonConverter {
  static readonly digitOnlyPattern = /^\d+$/;

  instructions: UdonInstruction[] = [];
  variableAddresses: Map<string, number> = new Map();
  variableTypes: Map<string, string> = new Map();
  tempAddresses: Map<number, number> = new Map();
  tempTypes: Map<number, string> = new Map();
  constantAddresses: Map<string, number> = new Map();
  constantTypes: Map<string, string> = new Map();
  nextAddress = 0;
  externSignatures: Set<string> = new Set();
  externSymbolBySignature: Map<string, string> = new Map();
  externAddressBySignature: Map<string, number> = new Map();
  nextExternId = 0;
  entryClassName: string | null = null;
  inlineClassNames: Set<string> = new Set();

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
      ...Array.from(this.constantAddresses.entries()).map(
        ([key, addr]): [string, number] => {
          const type = this.constantTypes.get(key) ?? "Single";
          const name = `__const_${addr}_System${type}`;
          return [name, addr];
        },
      ),
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

  // Bind helpers for module splitting
  convertInstruction = convertInstruction;

  pushOperand = pushOperand;
  getOperandAddress = getOperandAddress;
  getOperandTypeName = getOperandTypeName;
  getOperandUdonType = getOperandUdonType;
  normalizeVariableName = normalizeVariableName;
  getReturnValueAddress = getReturnValueAddress;

  getConstantKey = getConstantKey;
  parseConstantKey = parseConstantKey;
  getConstantKeyPayload = getConstantKeyPayload;
  formatInt64HexConstant = formatInt64HexConstant;

  getExternSymbol = getExternSymbol;
  getExternForBinaryOp = getExternForBinaryOp;
  getExternForUnaryOp = getExternForUnaryOp;
  getConvertExternSignature = getConvertExternSignature;
  getConvertMethodName = getConvertMethodName;
  getTruncateExternSignature = getTruncateExternSignature;

  isFloatType = isFloatType;
  isIntegerType = isIntegerType;
  mapUdonTypeToTs = mapUdonTypeToTs;
  getOperandTsTypeName = getOperandTsTypeName;
  extractInlineClassName = extractInlineClassName;
}

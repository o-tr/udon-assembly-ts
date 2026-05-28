/**
 * Convert TAC to Udon Assembly instructions
 */

import {
  type TACInstruction,
  TACInstructionKind,
} from "../../ir/tac_instruction.js";
import {
  type TACOperand,
  TACOperandKind,
  type TemporaryOperand,
} from "../../ir/tac_operand.js";
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
  pushConstant,
  pushOperand,
  resolveHeapType,
} from "./operands.js";
import {
  extractInlineClassName,
  getOperandTsTypeName,
  getPromotedNumericType,
  isFloatType,
  isIntegerType,
  isNumericType,
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
  tempAliases: Map<number, number> = new Map();
  tempUseRemaining: Map<number, number> = new Map();
  escapedTempIds: Set<number> = new Set();
  reusableTempAliasesByType: Map<string, number[]> = new Map();
  nextTempAliasId = 0;
  constantAddresses: Map<string, number> = new Map();
  constantTypes: Map<string, string> = new Map();
  nextAddress = 0;
  // Dedicated counter for synthetic label uniqueness — NEVER reused as a
  // variable address. Conflating with `nextAddress` (a strict variable-slot
  // allocator) would consume slot IDs without registering them, leaving holes
  // in the data section.
  labelCounter = 0;
  externSignatures: Set<string> = new Set();
  externSymbolBySignature: Map<string, string> = new Map();
  externAddressBySignature: Map<string, number> = new Map();
  nextExternId = 0;
  entryClassName: string | null = null;
  inlineClassNames: ReadonlySet<string> = new Set();

  /**
   * Convert TAC to Udon instructions
   */
  convert(
    tacInstructions: TACInstruction[],
    options?: {
      entryClassName?: string;
      inlineClassNames?: ReadonlySet<string>;
    },
  ): UdonInstruction[] {
    this.instructions = [];
    this.variableAddresses.clear();
    this.variableTypes.clear();
    this.tempAddresses.clear();
    this.tempTypes.clear();
    this.tempAliases.clear();
    this.tempUseRemaining.clear();
    this.escapedTempIds.clear();
    this.reusableTempAliasesByType.clear();
    this.constantAddresses.clear();
    this.constantTypes.clear();
    this.externSignatures.clear();
    this.externSymbolBySignature.clear();
    this.externAddressBySignature.clear();
    this.nextAddress = 0;
    this.nextTempAliasId = 0;
    this.labelCounter = 0;
    this.nextExternId = 0;
    this.entryClassName = options?.entryClassName ?? null;
    this.inlineClassNames = options?.inlineClassNames ?? new Set();
    this.prepareTemporaryReuse(tacInstructions);

    for (const tacInst of tacInstructions) {
      this.convertInstruction(tacInst);
      this.releaseTemporariesAfterInstruction(tacInst);
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
  pushConstant = pushConstant;
  getOperandAddress = getOperandAddress;
  getOperandTypeName = getOperandTypeName;
  getOperandUdonType = getOperandUdonType;
  normalizeVariableName = normalizeVariableName;
  getReturnValueAddress = getReturnValueAddress;

  allocateTemporaryAlias(temp: TemporaryOperand): number {
    const existing = this.tempAliases.get(temp.id);
    if (existing !== undefined) return existing;

    const typeName = resolveHeapType(temp.type);
    const reusable = this.reusableTempAliasesByType.get(typeName);
    const alias =
      reusable && reusable.length > 0
        ? (reusable.pop() as number)
        : this.nextTempAliasId++;
    this.tempAliases.set(temp.id, alias);
    if (!this.tempAddresses.has(alias)) {
      this.tempAddresses.set(alias, this.nextAddress++);
      this.tempTypes.set(alias, typeName);
    }
    return alias;
  }

  private prepareTemporaryReuse(tacInstructions: TACInstruction[]): void {
    for (const inst of tacInstructions) {
      this.collectEscapingTemporariesFromInstruction(inst, (temp) => {
        this.escapedTempIds.add(temp.id);
      });
      this.collectTemporariesFromInstruction(inst, (temp) => {
        this.tempUseRemaining.set(
          temp.id,
          (this.tempUseRemaining.get(temp.id) ?? 0) + 1,
        );
      });
    }
  }

  private releaseTemporariesAfterInstruction(inst: TACInstruction): void {
    this.collectTemporariesFromInstruction(inst, (temp) => {
      const remaining = (this.tempUseRemaining.get(temp.id) ?? 0) - 1;
      if (remaining > 0) {
        this.tempUseRemaining.set(temp.id, remaining);
        return;
      }

      this.tempUseRemaining.delete(temp.id);
      const alias = this.tempAliases.get(temp.id);
      if (alias === undefined) return;
      if (this.escapedTempIds.has(temp.id)) return;
      this.tempAliases.delete(temp.id);
      const typeName = resolveHeapType(temp.type);
      const reusable = this.reusableTempAliasesByType.get(typeName) ?? [];
      reusable.push(alias);
      this.reusableTempAliasesByType.set(typeName, reusable);
    });
  }

  private collectTemporariesFromOperand(
    operand: TACOperand | undefined,
    visit: (temp: TemporaryOperand) => void,
  ): void {
    if (operand?.kind === TACOperandKind.Temporary) {
      visit(operand as TemporaryOperand);
    }
  }

  private collectEscapingTemporariesFromInstruction(
    inst: TACInstruction,
    visit: (temp: TemporaryOperand) => void,
  ): void {
    if (inst.kind !== TACInstructionKind.MethodCall) return;
    const node = inst as TACInstruction & {
      object?: TACOperand;
      method?: string;
      args?: TACOperand[];
    };
    const objectType =
      node.object &&
      (node.object.kind === TACOperandKind.Variable ||
        node.object.kind === TACOperandKind.Constant ||
        node.object.kind === TACOperandKind.Temporary)
        ? resolveHeapType(
            (node.object as unknown as { type: TemporaryOperand["type"] }).type,
          )
        : "";
    const method = node.method ?? "";
    const storesDataToken =
      (objectType === "DataList" &&
        (method === "Add" || method === "Insert" || method === "set_Item")) ||
      (objectType === "DataDictionary" &&
        (method === "SetValue" || method === "set_Item"));
    if (!storesDataToken) return;

    for (const arg of node.args ?? []) {
      if (
        arg.kind === TACOperandKind.Temporary &&
        resolveHeapType((arg as TemporaryOperand).type) === "DataToken"
      ) {
        visit(arg as TemporaryOperand);
      }
    }
  }

  private collectTemporariesFromInstruction(
    inst: TACInstruction,
    visit: (temp: TemporaryOperand) => void,
  ): void {
    const node = inst as TACInstruction & {
      dest?: TACOperand;
      src?: TACOperand;
      left?: TACOperand;
      right?: TACOperand;
      operand?: TACOperand;
      condition?: TACOperand;
      object?: TACOperand;
      value?: TACOperand;
      array?: TACOperand;
      index?: TACOperand;
      args?: TACOperand[];
      sources?: Array<{ value: TACOperand }>;
    };
    switch (inst.kind) {
      case TACInstructionKind.Assignment:
      case TACInstructionKind.Copy:
      case TACInstructionKind.Cast:
        this.collectTemporariesFromOperand(node.dest, visit);
        this.collectTemporariesFromOperand(node.src, visit);
        return;
      case TACInstructionKind.BinaryOp:
        this.collectTemporariesFromOperand(node.dest, visit);
        this.collectTemporariesFromOperand(node.left, visit);
        this.collectTemporariesFromOperand(node.right, visit);
        return;
      case TACInstructionKind.UnaryOp:
        this.collectTemporariesFromOperand(node.dest, visit);
        this.collectTemporariesFromOperand(node.operand, visit);
        return;
      case TACInstructionKind.ConditionalJump:
        this.collectTemporariesFromOperand(node.condition, visit);
        return;
      case TACInstructionKind.UnconditionalJump:
      case TACInstructionKind.Label:
        return;
      case TACInstructionKind.Call:
        this.collectTemporariesFromOperand(node.dest, visit);
        for (const arg of node.args ?? []) {
          this.collectTemporariesFromOperand(arg, visit);
        }
        return;
      case TACInstructionKind.MethodCall:
        this.collectTemporariesFromOperand(node.dest, visit);
        this.collectTemporariesFromOperand(node.object, visit);
        for (const arg of node.args ?? []) {
          this.collectTemporariesFromOperand(arg, visit);
        }
        return;
      case TACInstructionKind.PropertyGet:
        this.collectTemporariesFromOperand(node.dest, visit);
        this.collectTemporariesFromOperand(node.object, visit);
        return;
      case TACInstructionKind.PropertySet:
        this.collectTemporariesFromOperand(node.object, visit);
        this.collectTemporariesFromOperand(node.value, visit);
        return;
      case TACInstructionKind.Return:
        this.collectTemporariesFromOperand(node.value, visit);
        return;
      case TACInstructionKind.ArrayAccess:
        this.collectTemporariesFromOperand(node.dest, visit);
        this.collectTemporariesFromOperand(node.array, visit);
        this.collectTemporariesFromOperand(node.index, visit);
        return;
      case TACInstructionKind.ArrayAssignment:
        this.collectTemporariesFromOperand(node.array, visit);
        this.collectTemporariesFromOperand(node.index, visit);
        this.collectTemporariesFromOperand(node.value, visit);
        return;
      case TACInstructionKind.Phi:
        this.collectTemporariesFromOperand(node.dest, visit);
        for (const source of node.sources ?? []) {
          this.collectTemporariesFromOperand(source.value, visit);
        }
        return;
    }
  }

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
  isNumericType = isNumericType;
  getPromotedNumericType = getPromotedNumericType;
  mapUdonTypeToTs = mapUdonTypeToTs;
  getOperandTsTypeName = getOperandTsTypeName;
  extractInlineClassName = extractInlineClassName;
}

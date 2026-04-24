/**
 * Udon Assembly (.uasm) file generator
 */

import { isVrcEventLabel } from "../vrc/event_registry.js";
import type { UdonInstruction } from "./udon_instruction.js";
import {
  ExternInstruction,
  type JumpIfFalseInstruction,
  type JumpInstruction,
  type LabelInstruction,
  PushInstruction,
  UdonInstructionKind,
} from "./udon_instruction.js";
import {
  mapTypeScriptToCSharp,
  toUdonTypeNameWithArray,
} from "./udon_type_resolver.js";

/**
 * Types that VRChat's UASM assembler only accepts as `null` (or `this`) in the
 * data section.  The UASM scanner cannot parse Int64/UInt64 hex literals
 * (16-digit hex overflows Convert.ToUInt32) and explicitly rejects non-null
 * initializers for these types.
 */
const NULL_ONLY_TYPES = new Set([
  "Boolean",
  "SystemBoolean",
  "System.Boolean",
  "Int64",
  "SystemInt64",
  "System.Int64",
  "UInt64",
  "SystemUInt64",
  "System.UInt64",
]);

const FLOAT_TYPES = new Set([
  "Single",
  "Double",
  "SystemSingle",
  "SystemDouble",
  "System.Single",
  "System.Double",
]);

const INTEGER_TYPES = new Set([
  "Byte",
  "SByte",
  "Int16",
  "UInt16",
  "Int32",
  "UInt32",
  "SystemByte",
  "SystemSByte",
  "SystemInt16",
  "SystemUInt16",
  "SystemInt32",
  "SystemUInt32",
  "System.Byte",
  "System.SByte",
  "System.Int16",
  "System.UInt16",
  "System.Int32",
  "System.UInt32",
]);

const UINT32_TYPES = new Set(["UInt32", "SystemUInt32", "System.UInt32"]);

const STRING_TYPES = new Set(["String", "SystemString", "System.String"]);

const BOOLEAN_TYPES = new Set(["Boolean", "SystemBoolean", "System.Boolean"]);

/**
 * Udon assembler - generates .uasm output
 */
type TypeCategory = "boolean" | "float" | "integer" | "string" | "other";

interface TypeClassification {
  category: TypeCategory;
  csharpType: string;
  udonType: string;
  isNullOnly: boolean;
}

export class UdonAssembler {
  private warnings: string[] = [];
  private typeClassificationCache = new Map<string, TypeClassification>();

  getWarnings(): string[] {
    return this.warnings.slice();
  }

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

  private expandToDecimal(value: number): string {
    const text = value.toString();
    return text.includes("e") || text.includes("E")
      ? this.expandExponentialLiteral(text)
      : text;
  }

  private formatFloatLiteral(value: number): string {
    if (!Number.isFinite(value)) {
      return JSON.stringify(value);
    }

    const expanded = this.expandToDecimal(value);

    // Large floats whose integer part exceeds 9 digits are lowered to
    // null by lowerRestrictedTypes and initialised at runtime via
    // Single.Parse / Double.Parse.  This branch should not be reached
    // in practice, but guards against callers that bypass lowering.
    if (this.integerPartOverflowsInt32(expanded)) {
      this.warnings.push(
        `[formatFloatLiteral] Overflowing float value ${value} was not lowered by lowerRestrictedTypes; emitting null. Ensure lowerRestrictedTypes is called before assembly.`,
      );
      return "null";
    }

    if (expanded.includes(".")) {
      return expanded;
    }

    return `${expanded}.0`;
  }

  /**
   * Check whether the integer part of a numeric string would overflow
   * Int32.Parse() in VRChat's UASM scanner.  The scanner lexes '-' as
   * a separate token, so only unsigned digit count matters.  Any value
   * with more than 9 integer digits is conservatively flagged
   * (999_999_999 < Int32.MaxValue = 2_147_483_647 < 9_999_999_999).
   */
  private integerPartOverflowsInt32(text: string): boolean {
    const unsigned = text.replace(/^[+-]/, "");
    const integerPart = unsigned.split(/[.eE]/)[0];
    return integerPart.length > 9;
  }

  /**
   * Check whether a finite float value would overflow the UASM scanner
   * when emitted as a decimal literal.
   */
  private floatValueOverflowsScanner(value: number): boolean {
    if (!Number.isFinite(value)) return false;
    return this.integerPartOverflowsInt32(this.expandToDecimal(value));
  }

  private isIntegerType(typeName: string): boolean {
    return INTEGER_TYPES.has(typeName);
  }

  private isUInt32Type(typeName: string): boolean {
    return UINT32_TYPES.has(typeName);
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
    const bounds = this.getIntegerBounds(typeName);
    if (bounds) {
      if (truncated < bounds.min) {
        truncated = bounds.min;
      } else if (truncated > bounds.max) {
        truncated = bounds.max;
      }
    }

    // UInt32 values > Int32.MaxValue must be emitted as hex because the
    // UASM scanner uses Int32.Parse for decimal literals which would overflow.
    if (this.isUInt32Type(typeName) && truncated > 2147483647) {
      return `0x${(truncated >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
    }

    // Int32.MinValue (-2147483648): the UASM scanner lexes '-' as a
    // separate token and then calls Int32.Parse("2147483648") which
    // overflows.  Emit as hex: C#'s int.Parse("80000000",
    // NumberStyles.HexNumber) correctly yields -2147483648.
    if (truncated === -2147483648) {
      return "0x80000000";
    }

    const text = truncated.toString();
    const expanded =
      text.includes("e") || text.includes("E")
        ? this.expandExponentialLiteral(text)
        : text;

    return expanded.includes(".") ? expanded.split(".")[0] : expanded;
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

  private classifyType(type: string): TypeClassification {
    const cached = this.typeClassificationCache.get(type);
    if (cached) return cached;

    const csharpType = mapTypeScriptToCSharp(type);
    const udonType = this.resolveUdonTypeName(type);

    let category: TypeCategory;
    if (
      BOOLEAN_TYPES.has(type) ||
      BOOLEAN_TYPES.has(csharpType) ||
      BOOLEAN_TYPES.has(udonType)
    ) {
      category = "boolean";
    } else if (
      FLOAT_TYPES.has(type) ||
      FLOAT_TYPES.has(csharpType) ||
      FLOAT_TYPES.has(udonType)
    ) {
      category = "float";
    } else if (
      INTEGER_TYPES.has(type) ||
      INTEGER_TYPES.has(csharpType) ||
      INTEGER_TYPES.has(udonType)
    ) {
      category = "integer";
    } else if (
      STRING_TYPES.has(type) ||
      STRING_TYPES.has(csharpType) ||
      STRING_TYPES.has(udonType)
    ) {
      category = "string";
    } else {
      category = "other";
    }

    const isNullOnly =
      NULL_ONLY_TYPES.has(type) ||
      NULL_ONLY_TYPES.has(csharpType) ||
      NULL_ONLY_TYPES.has(udonType);

    const result: TypeClassification = {
      category,
      csharpType,
      udonType,
      isNullOnly,
    };
    this.typeClassificationCache.set(type, result);
    return result;
  }

  /**
   * Format byte address as hex string
   */
  private formatHexAddress(byteAddr: number): string {
    return `0x${byteAddr.toString(16).toUpperCase().padStart(8, "0")}`;
  }

  /**
   * Lower restricted types in the data section to `null` and generate init instructions
   * that run after `_start` to set the correct values at runtime.
   */
  private lowerRestrictedTypes(
    dataSection: Array<[string, number, string, unknown]>,
    instructions: UdonInstruction[],
  ): {
    dataSection: Array<[string, number, string, unknown]>;
    instructions: UdonInstruction[];
  } {
    // Collect restricted entries with non-null, non-default values
    const initEntries: Array<{
      name: string;
      udonType: string;
      value: unknown;
    }> = [];
    const restrictedIndices: number[] = [];

    for (let i = 0; i < dataSection.length; i++) {
      const entry = dataSection[i];
      const [name, , type, value] = entry;
      const { udonType, category, isNullOnly } = this.classifyType(type);

      const isOverflowingFloat =
        !isNullOnly &&
        typeof value === "number" &&
        category === "float" &&
        this.floatValueOverflowsScanner(value);

      if (!isNullOnly && !isOverflowingFloat) continue;
      if (value === null) continue;

      restrictedIndices.push(i);

      // For booleans, `false` is the default (null represents false in Udon VM).
      // For Int64/UInt64, `0` is the default (null represents 0 in Udon VM).
      const isDefault =
        value === false ||
        value === 0 ||
        value === 0n ||
        (typeof value === "string" && /^0x0+$/i.test(value));

      if (!isDefault) {
        initEntries.push({ name, udonType, value });
      }
    }

    if (initEntries.length === 0) {
      return { dataSection, instructions };
    }

    const mutData = dataSection.map(
      (entry) => [...entry] as [string, number, string, unknown],
    );
    const mutInstructions = [...instructions];

    for (const i of restrictedIndices) {
      mutData[i][3] = null;
    }

    // Data section addresses are dense sequential indices (allocated via
    // nextAddress++ in TACToUdonConverter), so maxAddr + 1 is collision-free.
    let maxAddr = 0;
    for (const [, addr] of mutData) {
      if (addr > maxAddr) maxAddr = addr;
    }
    let nextAddr = maxAddr + 1;
    const existingNames = new Set(mutData.map(([name]) => name));
    const allocateUniqueHelperName = (baseName: string): string => {
      let candidate = baseName;
      let suffix = 1;
      while (existingNames.has(candidate)) {
        candidate = `${baseName}_${suffix}`;
        suffix += 1;
      }
      existingNames.add(candidate);
      return candidate;
    };

    // Track helper data entries to deduplicate
    let int32ZeroName: string | null = null;
    let eqExternName: string | null = null;
    // Cache for Int64/UInt64 convert externs and Int32 source constants
    let convertToInt64ExternName: string | null = null;
    let convertToUInt64ExternName: string | null = null;
    const int32ConstantNames = new Map<number, string>();
    // Cache for float parse externs and string constants
    let parseSingleExternName: string | null = null;
    let parseDoubleExternName: string | null = null;
    const floatStringNames = new Map<string, string>();

    const initInstructions: UdonInstruction[] = [];

    for (const { name, udonType, value } of initEntries) {
      if (value === true) {
        // Boolean true: use (0 == 0) → true
        if (int32ZeroName === null) {
          int32ZeroName = allocateUniqueHelperName("__asm_restrict_int32_0");
          mutData.push([int32ZeroName, nextAddr++, "Int32", 0]);
        }
        if (eqExternName === null) {
          eqExternName = allocateUniqueHelperName("__asm_restrict_eq_extern");
          mutData.push([
            eqExternName,
            nextAddr++,
            "String",
            "SystemInt32.__op_Equality__SystemInt32_SystemInt32__SystemBoolean",
          ]);
        }
        // PUSH int32_0, PUSH int32_0, PUSH target, EXTERN eq
        // Udon VM requires return address on stack before EXTERN
        initInstructions.push(new PushInstruction(int32ZeroName));
        initInstructions.push(new PushInstruction(int32ZeroName));
        initInstructions.push(new PushInstruction(name));
        initInstructions.push(new ExternInstruction(eqExternName, true));
      } else if (udonType === "SystemInt64" || udonType === "SystemUInt64") {
        // TODO(TRACK_INT64_INIT_LIMITATION): Runtime init for Int64/UInt64
        // uses SystemConvert.ToInt64/ToUInt64 from an Int32 source, so only
        // values in the Int32 range (or 0..Int32.Max for UInt64) can be
        // initialised. Larger values require a multi-step conversion or a
        // different runtime init strategy.
        const int64Value = this.parseRestrictedInt64Value(value);
        const isUnsigned = udonType === "SystemUInt64";
        if (
          int64Value === null ||
          int64Value < (isUnsigned ? 0n : -2147483648n) ||
          int64Value > 2147483647n
        ) {
          const displayValue =
            typeof value === "bigint" ? `${value}n` : JSON.stringify(value);
          this.warnings.push(
            `[TRACK_INT64_INIT_LIMITATION] ${udonType} value ${displayValue} on '${name}' is outside the representable Int32 range for runtime init; leaving as null`,
          );
          continue;
        }
        const int32Val = Number(int64Value);

        // Get or create Int32 constant for the source value
        let srcName = int32ConstantNames.get(int32Val);
        if (!srcName) {
          srcName = allocateUniqueHelperName(
            `__asm_restrict_int32_${int32Val < 0 ? `n${-int32Val}` : int32Val}`,
          );
          mutData.push([srcName, nextAddr++, "Int32", int32Val]);
          int32ConstantNames.set(int32Val, srcName);
        }

        // Get or create convert extern
        if (isUnsigned) {
          if (convertToUInt64ExternName === null) {
            convertToUInt64ExternName = allocateUniqueHelperName(
              "__asm_restrict_cvt_uint64_extern",
            );
            mutData.push([
              convertToUInt64ExternName,
              nextAddr++,
              "String",
              "SystemConvert.__ToUInt64__SystemInt32__SystemUInt64",
            ]);
          }
        } else {
          if (convertToInt64ExternName === null) {
            convertToInt64ExternName = allocateUniqueHelperName(
              "__asm_restrict_cvt_int64_extern",
            );
            mutData.push([
              convertToInt64ExternName,
              nextAddr++,
              "String",
              "SystemConvert.__ToInt64__SystemInt32__SystemInt64",
            ]);
          }
        }
        const externName = isUnsigned
          ? convertToUInt64ExternName
          : convertToInt64ExternName;
        if (externName === null) {
          throw new Error(
            `Missing convert extern for ${udonType} on '${name}'`,
          );
        }

        // PUSH int32_src, PUSH target, EXTERN convert
        // Udon VM requires return address on stack before EXTERN
        initInstructions.push(new PushInstruction(srcName));
        initInstructions.push(new PushInstruction(name));
        initInstructions.push(new ExternInstruction(externName, true));
      } else if (
        (udonType === "SystemSingle" || udonType === "SystemDouble") &&
        typeof value === "number"
      ) {
        // Large float: use Single.Parse / Double.Parse from string
        const strValue = value.toString();
        let srcStrName = floatStringNames.get(strValue);
        if (!srcStrName) {
          srcStrName = allocateUniqueHelperName("__asm_restrict_float_str");
          mutData.push([srcStrName, nextAddr++, "String", strValue]);
          floatStringNames.set(strValue, srcStrName);
        }

        const isSingle = udonType === "SystemSingle";
        if (isSingle) {
          if (parseSingleExternName === null) {
            parseSingleExternName = allocateUniqueHelperName(
              "__asm_restrict_parse_single_extern",
            );
            mutData.push([
              parseSingleExternName,
              nextAddr++,
              "String",
              "SystemSingle.__Parse__SystemString__SystemSingle",
            ]);
          }
        } else {
          if (parseDoubleExternName === null) {
            parseDoubleExternName = allocateUniqueHelperName(
              "__asm_restrict_parse_double_extern",
            );
            mutData.push([
              parseDoubleExternName,
              nextAddr++,
              "String",
              "SystemDouble.__Parse__SystemString__SystemDouble",
            ]);
          }
        }
        const parseExternName = (
          isSingle ? parseSingleExternName : parseDoubleExternName
        ) as string;

        // PUSH str_src, PUSH target, EXTERN parse
        // Udon VM requires return address on stack before EXTERN
        initInstructions.push(new PushInstruction(srcStrName));
        initInstructions.push(new PushInstruction(name));
        initInstructions.push(new ExternInstruction(parseExternName, true));
      } else {
        this.warnings.push(
          `No runtime init path for restricted type value ${JSON.stringify(value)} on '${name}' (${udonType}); leaving as null`,
        );
      }
    }

    if (initInstructions.length === 0) {
      return { dataSection: mutData, instructions: mutInstructions };
    }

    // Find _start label and insert init instructions after it
    const startIdx = mutInstructions.findIndex(
      (inst) =>
        inst.kind === UdonInstructionKind.Label &&
        (inst as LabelInstruction).name === "_start",
    );

    if (startIdx !== -1) {
      mutInstructions.splice(startIdx + 1, 0, ...initInstructions);
    } else {
      this.warnings.push(
        "_start label not found; restricted-type init code prepended to instruction stream and may be dead code. Ensure the program has an explicit _start or event entry point.",
      );
      mutInstructions.unshift(...initInstructions);
    }

    return { dataSection: mutData, instructions: mutInstructions };
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
    // Lower restricted types before assembly
    let effectiveData = dataSection;
    let effectiveInstructions = instructions;
    if (dataSection && dataSection.length > 0) {
      const lowered = this.lowerRestrictedTypes(dataSection, instructions);
      effectiveData = lowered.dataSection;
      effectiveInstructions = lowered.instructions;
    }

    const lines: string[] = [];

    // Compute label addresses early for resolving JUMP/JUMP_IF_FALSE targets
    const { labelAddresses, canonicalLabels } = this.computeLabelAddressInfo(
      effectiveInstructions,
      exportLabels,
    );

    // Data section
    lines.push(".data_start");
    lines.push("");

    // Data definitions (variables and constants)
    if (effectiveData && effectiveData.length > 0) {
      // Sort by address to ensure consistent output
      const sortedData = [...effectiveData].sort((a, b) => a[1] - b[1]);

      for (const [name, _address, type, value] of sortedData) {
        // Variable declaration: name: %Type, initialValue
        const { csharpType, udonType, category } = this.classifyType(type);

        const resolvedValue = value;

        let initialValue: string;

        if (resolvedValue === null) {
          initialValue = "null";
        } else if (category === "boolean") {
          initialValue = resolvedValue === true ? "true" : "false";
        } else if (
          udonType === "SystemType" &&
          typeof resolvedValue === "string"
        ) {
          initialValue = resolvedValue;
        } else if (
          typeof resolvedValue === "string" &&
          resolvedValue.startsWith("0x") &&
          category !== "string"
        ) {
          initialValue = resolvedValue;
        } else if (typeof resolvedValue === "number" && category === "float") {
          initialValue = this.formatFloatLiteral(resolvedValue);
        } else if (
          typeof resolvedValue === "number" &&
          category === "integer"
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

    // Convert instructions to text, replacing label references with addresses
    for (const inst of effectiveInstructions) {
      if (inst.kind === UdonInstructionKind.Label) {
        // Labels appear on their own line
        const labelName = (inst as LabelInstruction).name;
        const canonicalLabel = canonicalLabels.get(labelName) ?? labelName;
        // Keep externally callable labels even when same-address labels are
        // canonicalized; VRC events and exportLabels are part of the public ABI.
        const preserveAliasLabel =
          isVrcEventLabel(labelName) || exportLabels?.has(labelName);
        if (canonicalLabel !== labelName && !preserveAliasLabel) {
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
        if (typeof jumpInst.address === "number") {
          lines.push(`    JUMP, ${this.formatHexAddress(jumpInst.address)}`);
        } else {
          // Replace label with byte address
          const canonicalLabel =
            canonicalLabels.get(jumpInst.address) ?? jumpInst.address;
          const byteAddr = labelAddresses.get(canonicalLabel);
          if (byteAddr !== undefined) {
            lines.push(`    JUMP, ${this.formatHexAddress(byteAddr)}`);
          } else {
            this.warnings.push(
              `Unresolved label '${jumpInst.address}' in assembly output, using halt address`,
            );
            lines.push("    JUMP, 0xFFFFFFFC");
          }
        }
      } else if (inst.kind === UdonInstructionKind.JumpIfFalse) {
        const jumpInst = inst as JumpIfFalseInstruction;
        if (typeof jumpInst.address === "number") {
          lines.push(
            `    JUMP_IF_FALSE, ${this.formatHexAddress(jumpInst.address)}`,
          );
        } else {
          // Replace label with byte address
          const canonicalLabel =
            canonicalLabels.get(jumpInst.address) ?? jumpInst.address;
          const byteAddr = labelAddresses.get(canonicalLabel);
          if (byteAddr !== undefined) {
            lines.push(`    JUMP_IF_FALSE, ${this.formatHexAddress(byteAddr)}`);
          } else {
            this.warnings.push(
              `Unresolved label '${jumpInst.address}' in assembly output, using halt address`,
            );
            lines.push("    JUMP_IF_FALSE, 0xFFFFFFFC");
          }
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

  /**
   * Parse an Int64/UInt64 value from a data section entry into a BigInt.
   * Returns null if the value cannot be parsed.
   */
  private parseRestrictedInt64Value(value: unknown): bigint | null {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string") {
      try {
        return BigInt(value);
      } catch {
        return null;
      }
    }
    return null;
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

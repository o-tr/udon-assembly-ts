/**
 * UASM text parser — extracts semantic elements for comparison.
 */

export interface UasmData {
  /** Lines from .data_start to .data_end, each parsed as a variable entry */
  variables: UasmVariable[];
  /** Exported symbol names (from .export directives) */
  exports: string[];
  /** Extern signatures (full string from EXTERN, "..." lines) */
  externs: string[];
  /** Total instruction count in the code section */
  instructionCount: number;
  /** Sync mode (from .behaviourSyncMode, or null) */
  syncMode: string | null;
  /** Raw instruction lines (opcode only, no operands) for structural comparison */
  opcodes: string[];
}

export interface UasmVariable {
  name: string;
  type: string;
  defaultValue: string | null;
}

export function parseUasm(text: string): UasmData {
  const lines = text.split("\n").map((l) => l.trim());

  const variables: UasmVariable[] = [];
  const exports: string[] = [];
  const externs: string[] = [];
  const opcodes: string[] = [];
  // Map from __extern_N variable name to the actual extern signature string
  const externVarMap = new Map<string, string>();
  let syncMode: string | null = null;
  let instructionCount = 0;

  let inData = false;
  let inCode = false;

  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith("//") || rawLine.startsWith("#"))
      continue;
    // Strip trailing comments outside of quoted strings
    let line = rawLine;
    const trailingComment = line.match(/^([^"]*(?:"[^"]*"[^"]*)*)\/\//);
    if (trailingComment) {
      line = trailingComment[1].trim();
      if (!line) continue;
    }

    // .behaviourSyncMode can appear at top level (UdonSharp) or inside code section
    if (line.startsWith(".behaviourSyncMode ")) {
      syncMode = line.slice(".behaviourSyncMode ".length).trim();
      continue;
    }

    if (line === ".data_start") {
      inData = true;
      inCode = false;
      continue;
    }
    if (line === ".data_end") {
      inData = false;
      continue;
    }
    if (line === ".code_start") {
      inCode = true;
      inData = false;
      continue;
    }
    if (line === ".code_end") {
      inCode = false;
      continue;
    }

    if (inData) {
      // Format: varName: %TypeName, defaultValue
      //      or varName: %TypeName, null
      //      or varName: %TypeName
      if (line.startsWith(".") || line.startsWith("//")) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx <= 0) continue;

      const name = line.slice(0, colonIdx).trim();
      const rest = line.slice(colonIdx + 1).trim();

      // rest is like: %SystemString, "hello"  or  %UdonBehaviour, this  or  %SystemInt32, 0
      const commaIdx = rest.indexOf(",");
      if (commaIdx < 0) {
        // TASM stores extern signatures as data variables named __extern_N
        if (name.match(/^__extern_\d+$/)) continue;
        variables.push({ name, type: rest, defaultValue: null });
      } else {
        const type = rest.slice(0, commaIdx).trim();
        const defaultValue = rest.slice(commaIdx + 1).trim();
        // TASM stores extern signatures as: __extern_N: %SystemString, "ExternSignature"
        if (name.match(/^__extern_\d+$/)) {
          externVarMap.set(name, defaultValue.replace(/^"(.*)"$/, "$1"));
          continue;
        }
        variables.push({ name, type, defaultValue });
      }
      continue;
    }

    if (inCode) {
      if (line.startsWith(".export ")) {
        exports.push(line.slice(".export ".length).trim());
        continue;
      }
      // Skip label definitions (e.g. "_start:")
      if (line.endsWith(":") && !line.includes(",")) continue;
      // Skip .sync etc.
      if (line.startsWith(".")) continue;

      // Parse instruction: "OPCODE, operand" or "OPCODE"
      const commaIdx = line.indexOf(",");
      const opcode =
        commaIdx >= 0 ? line.slice(0, commaIdx).trim() : line.trim();

      if (opcode === "NOP") continue; // skip NOPs for counting
      instructionCount++;
      opcodes.push(opcode);

      // Extract extern signatures
      if (opcode === "EXTERN") {
        const operandRaw = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : "";
        // Handle both inline string: "SomeSig" and variable reference: __extern_N
        if (operandRaw.startsWith('"')) {
          const sig = operandRaw.replace(/^"(.*)"$/, "$1").trim();
          if (sig) externs.push(sig);
        } else {
          // Variable reference — resolve from data section
          const resolved = externVarMap.get(operandRaw);
          if (resolved) externs.push(resolved);
          else if (operandRaw) externs.push(operandRaw); // fallback: keep as-is
        }
      }
    }
  }

  // Post-loop fixup: guard against hypothetical out-of-order UASM where code
  // section precedes data section (standard UASM always has data first)
  for (let i = 0; i < externs.length; i++) {
    const resolved = externVarMap.get(externs[i]);
    if (resolved) externs[i] = resolved;
  }

  return { variables, exports, externs, instructionCount, syncMode, opcodes };
}

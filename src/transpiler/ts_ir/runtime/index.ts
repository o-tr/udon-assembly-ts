export type UdonInt = number & { readonly __udon: "Int32" };
export type UdonBool = boolean & { readonly __udon: "Boolean" };
export type UdonString = string & { readonly __udon: "String" };

export type Handle<T> = number & { readonly __handle: T };
export type NullHandle = 0 & { readonly __nullHandle: true };
export type MaybeHandle<T> = Handle<T> | NullHandle;

export const NULL_HANDLE = 0 as NullHandle;

export type DataToken<T = unknown> = {
  readonly __kind: "DataToken";
  readonly value: T;
  readonly __inlineSnapshot?: InlineHandleSnapshot;
};

export type TsIrContext = {
  readonly pc?: number;
  readonly instruction?: string;
  readonly extern?: string;
  readonly heap?: Record<string, unknown>;
};

type InlineHandleSnapshot = {
  readonly prefix: string;
  readonly fields: Readonly<Record<string, unknown>>;
};

export class UdonVMRuntimeError extends Error {
  constructor(
    message: string,
    readonly pc?: number,
    readonly instruction?: string,
    readonly extern?: string,
  ) {
    super(message);
    this.name = "UdonVMRuntimeError";
  }
}

export class DataList<T = unknown> {
  readonly items: T[];

  constructor(items: readonly T[] = []) {
    this.items = [...items];
  }
}

export class DataDictionary<K = unknown, V = unknown> {
  private readonly entries = new Map<string, { key: K; value: V }>();

  setValue(key: K, value: V): void {
    this.entries.set(stableKey(key), { key, value });
  }

  getValue(key: K, ctx: TsIrContext = {}): V {
    const found = this.entries.get(stableKey(key));
    if (!found) {
      throw runtimeError("DataDictionary key was not found", ctx);
    }
    restoreInlineSnapshot(found.value, ctx);
    return found.value;
  }

  containsKey(key: K): boolean {
    return this.entries.has(stableKey(key));
  }

  remove(key: K): boolean {
    return this.entries.delete(stableKey(key));
  }

  clear(): void {
    this.entries.clear();
  }

  getKeys(): DataList<K> {
    return new DataList(
      Array.from(this.entries.values(), (entry) => entry.key),
    );
  }

  getValues(): DataList<V> {
    return new DataList(
      Array.from(this.entries.values(), (entry) => entry.value),
    );
  }

  get count(): number {
    return this.entries.size;
  }
}

export type DebugLogEntry = {
  readonly level: "log" | "error";
  readonly value: unknown;
  readonly pc: number | undefined;
  readonly instruction: string | undefined;
};

export const debugLogs: DebugLogEntry[] = [];

export function clearDebugLogs(): void {
  debugLogs.length = 0;
}

export function debugLog(value: unknown, ctx: TsIrContext = {}): void {
  debugLogs.push({
    level: "log",
    value,
    pc: ctx.pc,
    instruction: ctx.instruction,
  });
}

export function debugLogError(value: unknown, ctx: TsIrContext = {}): void {
  debugLogs.push({
    level: "error",
    value,
    pc: ctx.pc,
    instruction: ctx.instruction,
  });
}

export function runtimeError(
  message: string,
  ctx: TsIrContext = {},
): UdonVMRuntimeError {
  return new UdonVMRuntimeError(message, ctx.pc, ctx.instruction, ctx.extern);
}

export function readSlot<T>(
  value: T | undefined,
  slot: string,
  ctx: TsIrContext = {},
): T {
  if (value === undefined) {
    throw runtimeError(
      `Heap slot '${slot}' was read before initialization`,
      ctx,
    );
  }
  return value;
}

export function dataToken<T = unknown>(
  value: T,
  ctx: TsIrContext = {},
): DataToken<T> {
  const snapshot = snapshotInlineHandle(value, ctx.heap);
  return snapshot
    ? { __kind: "DataToken", value, __inlineSnapshot: snapshot }
    : { __kind: "DataToken", value };
}

export function unwrapDataToken<T = unknown>(
  token: DataToken<T> | null | undefined,
  ctx: TsIrContext = {},
): T {
  if (token === undefined) {
    throw runtimeError("DataToken was read before initialization", ctx);
  }
  if (token === null) {
    throw runtimeError("DataToken reference is null", ctx);
  }
  return token.value;
}

export function coerceBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  return value !== null && value !== undefined;
}

export function castInt(value: unknown): number {
  const n = Number(value);
  return n < 0 ? Math.ceil(n) : Math.floor(n);
}

export function castFloat(value: unknown): number {
  return Number(value);
}

export function objectEquals(left: unknown, right: unknown): boolean {
  if (isJsNullish(left) && isJsNullish(right)) return true;
  return left === right;
}

export function nullEquals(value: unknown): boolean {
  return isNullishRuntimeValue(value);
}

function isJsNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

function isNullishRuntimeValue(value: unknown): boolean {
  return value === null || value === undefined || value === NULL_HANDLE;
}

export function binaryOp(
  left: unknown,
  operator: string,
  right: unknown,
  ctx: TsIrContext = {},
): unknown {
  switch (operator) {
    case "+":
      if (typeof left === "string" || typeof right === "string") {
        return String(left) + String(right);
      }
      return Number(left) + Number(right);
    case "-":
      return Number(left) - Number(right);
    case "*":
      return Number(left) * Number(right);
    case "/":
      return Number(left) / Number(right);
    case "%":
      return Number(left) % Number(right);
    case "<<":
      return Number(left) << Number(right);
    case ">>":
      return Number(left) >> Number(right);
    case "|":
      return Number(left) | Number(right);
    case "&":
      return Number(left) & Number(right);
    case "^":
      return Number(left) ^ Number(right);
    case "&&":
      return coerceBool(left) && coerceBool(right);
    case "||":
      return coerceBool(left) || coerceBool(right);
    case "==":
      return objectEquals(left, right);
    case "!=":
      return !objectEquals(left, right);
    case "===":
      return left === right;
    case "!==":
      return left !== right;
    case "<":
      return Number(left) < Number(right);
    case "<=":
      return Number(left) <= Number(right);
    case ">":
      return Number(left) > Number(right);
    case ">=":
      return Number(left) >= Number(right);
    default:
      throw runtimeError(`Unsupported binary operator '${operator}'`, ctx);
  }
}

export function unaryOp(
  operator: string,
  operand: unknown,
  ctx: TsIrContext = {},
): unknown {
  switch (operator) {
    case "-":
      return -Number(operand);
    case "+":
      return Number(operand);
    case "!":
      return !coerceBool(operand);
    case "~":
      return ~Number(operand);
    default:
      throw runtimeError(`Unsupported unary operator '${operator}'`, ctx);
  }
}

export function requireDataList<T>(
  value: DataList<T> | null | undefined,
  ctx: TsIrContext = {},
): DataList<T> {
  if (value === undefined) {
    throw runtimeError("DataList was read before initialization", ctx);
  }
  if (value === null) {
    throw runtimeError("DataList reference is null", ctx);
  }
  return value;
}

export function dataListCount<T>(
  value: DataList<T> | null | undefined,
  ctx: TsIrContext = {},
): number {
  return requireDataList(value, ctx).items.length;
}

export function dataListAdd<T>(
  value: DataList<T> | null | undefined,
  item: T,
  ctx: TsIrContext = {},
): void {
  requireDataList(value, ctx).items.push(item);
}

export function dataListGet<T>(
  value: DataList<T> | null | undefined,
  index: unknown,
  ctx: TsIrContext = {},
): T {
  const list = requireDataList(value, ctx);
  const i = castInt(index);
  if (i < 0 || i >= list.items.length) {
    throw runtimeError(`DataList index ${i} is out of range`, ctx);
  }
  const item = list.items[i] as T;
  restoreInlineSnapshot(item, ctx);
  return item;
}

export function dataListSet<T>(
  value: DataList<T> | null | undefined,
  index: unknown,
  item: T,
  ctx: TsIrContext = {},
): void {
  const list = requireDataList(value, ctx);
  const i = castInt(index);
  if (i < 0 || i >= list.items.length) {
    throw runtimeError(`DataList index ${i} is out of range`, ctx);
  }
  list.items[i] = item;
}

export function requireDataDictionary<K, V>(
  value: DataDictionary<K, V> | null | undefined,
  ctx: TsIrContext = {},
): DataDictionary<K, V> {
  if (value === undefined) {
    throw runtimeError("DataDictionary was read before initialization", ctx);
  }
  if (value === null) {
    throw runtimeError("DataDictionary reference is null", ctx);
  }
  return value;
}

export function dispatchExtern(
  extern: string,
  args: readonly unknown[],
  ctx: TsIrContext = {},
): unknown {
  const externCtx = { ...ctx, extern };
  if (/Array\.__ctor__SystemInt32__/.test(extern)) {
    return new Array(castInt(args[0])).fill(undefined);
  }
  switch (extern) {
    case "VRCSDK3DataDataList.__ctor____VRCSDK3DataDataList":
      return new DataList();
    case "VRCSDK3DataDataDictionary.__ctor____VRCSDK3DataDataDictionary":
      return new DataDictionary();
    case "VRCSDK3DataDataToken.__op_Implicit__SystemDouble__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__op_Implicit__SystemInt32__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__op_Implicit__SystemBoolean__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__op_Implicit__SystemString__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__op_Implicit__SystemObject__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__op_Implicit__VRCSDK3DataDataList__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__op_Implicit__VRCSDK3DataDataDictionary__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__ctor__SystemDouble__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__ctor__SystemInt32__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__ctor__SystemBoolean__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__ctor__SystemString__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__ctor__SystemObject__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__ctor__VRCSDK3DataDataList__VRCSDK3DataDataToken":
    case "VRCSDK3DataDataToken.__ctor__VRCSDK3DataDataDictionary__VRCSDK3DataDataToken":
      return dataToken(args[0], externCtx);
    case "VRCSDK3DataDataToken.__get_Double__SystemDouble":
    case "VRCSDK3DataDataToken.__get_Int__SystemInt32":
    case "VRCSDK3DataDataToken.__get_Boolean__SystemBoolean":
    case "VRCSDK3DataDataToken.__get_String__SystemString":
    case "VRCSDK3DataDataToken.__get_Reference__SystemObject":
      return unwrapDataToken(args[0] as DataToken<unknown> | null, externCtx);
    case "UnityEngineDebug.__Log__SystemObject__SystemVoid":
      debugLog(args[0], externCtx);
      return undefined;
    case "UnityEngineDebug.__LogError__SystemObject__SystemVoid":
      debugLogError(args[0], externCtx);
      return undefined;
    case "SystemString.__Concat__SystemString_SystemString__SystemString":
    case "SystemString.__Concat__SystemObject_SystemObject__SystemString":
      return `${String(args[0])}${String(args[1])}`;
    case "SystemString.__IsNullOrEmpty__SystemString__SystemBoolean":
      return args[0] === null || args[0] === undefined || args[0] === "";
    case "SystemInt32.__Parse__SystemString__SystemInt32":
      return castInt(args[0]);
    case "SystemMath.__Max__SystemDouble_SystemDouble__SystemDouble":
      return Math.max(castFloat(args[0]), castFloat(args[1]));
    case "SystemMath.__Ceiling__SystemDouble__SystemDouble":
      return Math.ceil(castFloat(args[0]));
    case "UnityEngineMathf.__Abs__SystemSingle__SystemSingle":
      return Math.abs(castFloat(args[0]));
    case "UnityEngineMathf.__Ceil__SystemSingle__SystemSingle":
      return Math.ceil(castFloat(args[0]));
    case "UnityEngineMathf.__CeilToInt__SystemSingle__SystemInt32":
      return Math.ceil(castFloat(args[0]));
    case "UnityEngineMathf.__Clamp__SystemSingle_SystemSingle_SystemSingle__SystemSingle":
      return Math.min(
        Math.max(castFloat(args[0]), castFloat(args[1])),
        castFloat(args[2]),
      );
    case "UnityEngineMathf.__Clamp01__SystemSingle__SystemSingle":
      return Math.min(Math.max(castFloat(args[0]), 0), 1);
    case "UnityEngineMathf.__Floor__SystemSingle__SystemSingle":
      return Math.floor(castFloat(args[0]));
    case "UnityEngineMathf.__FloorToInt__SystemSingle__SystemInt32":
      return Math.floor(castFloat(args[0]));
    case "UnityEngineMathf.__Lerp__SystemSingle_SystemSingle_SystemSingle__SystemSingle":
      return (
        castFloat(args[0]) +
        (castFloat(args[1]) - castFloat(args[0])) *
          Math.min(Math.max(castFloat(args[2]), 0), 1)
      );
    case "UnityEngineMathf.__Max__SystemSingle_SystemSingle__SystemSingle":
      return Math.max(castFloat(args[0]), castFloat(args[1]));
    case "UnityEngineMathf.__Min__SystemSingle_SystemSingle__SystemSingle":
      return Math.min(castFloat(args[0]), castFloat(args[1]));
    case "UnityEngineMathf.__Pow__SystemSingle_SystemSingle__SystemSingle":
      return castFloat(args[0]) ** castFloat(args[1]);
    case "UnityEngineMathf.__Round__SystemSingle__SystemSingle":
      return Math.round(castFloat(args[0]));
    case "UnityEngineMathf.__RoundToInt__SystemSingle__SystemInt32":
      return Math.round(castFloat(args[0]));
    case "UnityEngineMathf.__Sin__SystemSingle__SystemSingle":
      return Math.sin(castFloat(args[0]));
    case "UnityEngineMathf.__Cos__SystemSingle__SystemSingle":
      return Math.cos(castFloat(args[0]));
    case "UnityEngineMathf.__Sqrt__SystemSingle__SystemSingle":
      return Math.sqrt(castFloat(args[0]));
    case "UnityEngineMathf.__Tan__SystemSingle__SystemSingle":
      return Math.tan(castFloat(args[0]));
    default:
      throw runtimeError(`Unknown extern '${extern}'`, externCtx);
  }
}

export function callMethod(
  object: unknown,
  method: string,
  args: readonly unknown[],
  ctx: TsIrContext = {},
): unknown {
  if (typeof object === "string") {
    switch (method) {
      case "Substring": {
        const start = castInt(args[0]);
        if (args.length >= 2) {
          const length = castInt(args[1]);
          return object.substring(start, start + length);
        }
        return object.substring(start);
      }
      case "IndexOf":
      case "indexOf":
        return object.indexOf(String(args[0]));
      case "Contains":
      case "includes":
        return object.includes(String(args[0]));
      case "StartsWith":
      case "startsWith":
        return object.startsWith(String(args[0]));
      case "EndsWith":
      case "endsWith":
        return object.endsWith(String(args[0]));
      case "ToString":
      case "toString":
        return object;
      default:
        throw runtimeError(`Unsupported string method '${method}'`, ctx);
    }
  }
  if (method === "ToString" || method === "toString") {
    if (object === null || object === undefined || object === NULL_HANDLE) {
      return "";
    }
    return String(object);
  }
  if (object instanceof DataList) {
    switch (method) {
      case "Add":
        dataListAdd(object, args[0], ctx);
        return undefined;
      case "get_Item":
      case "GetValue":
        return dataListGet(object, args[0], ctx);
      case "set_Item":
        dataListSet(object, args[0], args[1], ctx);
        return undefined;
      case "pop":
      case "Pop":
        return object.items.pop();
      default:
        throw runtimeError(`Unsupported DataList method '${method}'`, ctx);
    }
  }
  if (object instanceof DataDictionary) {
    switch (method) {
      case "SetValue":
      case "Add":
        object.setValue(args[0], args[1]);
        return undefined;
      case "GetValue":
      case "get_Item":
        return object.getValue(args[0], ctx);
      case "ContainsKey":
        return object.containsKey(args[0]);
      case "Remove":
        return object.remove(args[0]);
      case "Clear":
        object.clear();
        return undefined;
      case "GetKeys":
        return object.getKeys();
      case "GetValues":
        return object.getValues();
      default:
        throw runtimeError(
          `Unsupported DataDictionary method '${method}'`,
          ctx,
        );
    }
  }
  if (object === null || object === undefined || object === NULL_HANDLE) {
    throw runtimeError(`Cannot call '${method}' on a null object`, ctx);
  }
  throw runtimeError(
    `Unsupported method '${method}' on ${describeValue(object)}`,
    ctx,
  );
}

export function getProperty(
  object: unknown,
  property: string,
  ctx: TsIrContext = {},
): unknown {
  if (Array.isArray(object)) {
    if (property === "Length") return object.length;
    throw runtimeError(`Unsupported array property '${property}'`, ctx);
  }
  if (typeof object === "string") {
    if (property === "Length") return object.length;
    throw runtimeError(`Unsupported string property '${property}'`, ctx);
  }
  if (object instanceof DataList) {
    if (property === "Count") return dataListCount(object, ctx);
    throw runtimeError(`Unsupported DataList property '${property}'`, ctx);
  }
  if (object instanceof DataDictionary) {
    if (property === "Count") return object.count;
    throw runtimeError(
      `Unsupported DataDictionary property '${property}'`,
      ctx,
    );
  }
  if (isDataToken(object)) {
    switch (property) {
      case "IsNull":
        return object.value === null;
      case "DataList":
        if (object.value instanceof DataList) return object.value;
        throw runtimeError(
          `DataToken value is not a DataList: ${describeValue(object.value)}`,
          ctx,
        );
      case "DataDictionary":
        if (object.value instanceof DataDictionary) return object.value;
        throw runtimeError(
          `DataToken value is not a DataDictionary: ${describeValue(object.value)}`,
          ctx,
        );
      case "Reference":
        if (
          object.value === null ||
          object.value === undefined ||
          typeof object.value === "object"
        ) {
          return object.value;
        }
        throw runtimeError(
          `DataToken value is not a reference: ${describeValue(object.value)}`,
          ctx,
        );
      case "String":
      case "Boolean":
      case "Double":
      case "Int":
        return object.value;
      case "Count":
        if (object.value instanceof DataList) return object.value.items.length;
        if (object.value instanceof DataDictionary) return object.value.count;
        if (Array.isArray(object.value)) return object.value.length;
        if (typeof object.value === "string") return object.value.length;
        throw runtimeError(
          `DataToken Count is unavailable: ${describeValue(object.value)}`,
          ctx,
        );
      default:
        throw runtimeError(`Unsupported DataToken property '${property}'`, ctx);
    }
  }
  if (object === null || object === undefined || object === NULL_HANDLE) {
    throw runtimeError(`Cannot read '${property}' from a null object`, ctx);
  }
  if (typeof object === "object" && property in object) {
    return (object as Record<string, unknown>)[property];
  }
  throw runtimeError(`Unsupported property '${property}'`, ctx);
}

export function setProperty(
  object: unknown,
  property: string,
  value: unknown,
  ctx: TsIrContext = {},
): void {
  if (object === null || object === undefined || object === NULL_HANDLE) {
    throw runtimeError(`Cannot write '${property}' on a null object`, ctx);
  }
  if (typeof object === "object") {
    (object as Record<string, unknown>)[property] = value;
    return;
  }
  throw runtimeError(`Unsupported property set '${property}'`, ctx);
}

type EncodedOperand = readonly [string, unknown?];
type EncodedInstruction = readonly unknown[];

export function runTacProgram(
  program: readonly EncodedInstruction[],
  slotDefaults: Readonly<Record<string, string>> = {},
): {
  readonly heap: Record<string, unknown>;
  readonly logs: readonly DebugLogEntry[];
} {
  clearDebugLogs();
  const heap: Record<string, unknown> = {};
  let pc = 0;
  while (true) {
    if (pc < 0 || pc > program.length) {
      throw runtimeError(`Invalid TS IR pc ${pc}`, { pc });
    }
    if (pc === program.length) {
      return { heap, logs: [...debugLogs] };
    }
    const instruction = program[pc];
    if (instruction === undefined) {
      throw runtimeError(`Missing TS IR instruction at pc ${pc}`, { pc });
    }
    const op = String(instruction[0]);
    const ctx = { pc, heap };
    switch (op) {
      case "a": {
        const dest = String(instruction[1]);
        const source = instruction[2] as EncodedOperand;
        heap[dest] = readEncodedOperand(source, heap, ctx, slotDefaults);
        if (source[0] === "s") {
          heap[aliasSlot(dest)] = String(source[1]);
        } else {
          delete heap[aliasSlot(dest)];
        }
        pc += 1;
        break;
      }
      case "b": {
        heap[String(instruction[1])] = binaryOp(
          readEncodedOperand(
            instruction[3] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          ),
          String(instruction[2]),
          readEncodedOperand(
            instruction[4] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          ),
          ctx,
        );
        pc += 1;
        break;
      }
      case "u": {
        heap[String(instruction[1])] = unaryOp(
          String(instruction[2]),
          readEncodedOperand(
            instruction[3] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          ),
          ctx,
        );
        pc += 1;
        break;
      }
      case "c": {
        const value = readEncodedOperand(
          instruction[3] as EncodedOperand,
          heap,
          ctx,
          slotDefaults,
        );
        switch (instruction[2]) {
          case "i":
            heap[String(instruction[1])] = castInt(value);
            break;
          case "f":
            heap[String(instruction[1])] = castFloat(value);
            break;
          case "b":
            heap[String(instruction[1])] = coerceBool(value);
            break;
          default:
            heap[String(instruction[1])] = value;
            break;
        }
        pc += 1;
        break;
      }
      case "cj":
        pc = coerceBool(
          readEncodedOperand(
            instruction[1] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          ),
        )
          ? pc + 1
          : Number(instruction[2]);
        break;
      case "j":
        pc = Number(instruction[1]);
        break;
      case "l":
        pc += 1;
        break;
      case "call": {
        const value = dispatchExtern(
          String(instruction[2]),
          readEncodedOperands(instruction[3], heap, ctx, slotDefaults),
          ctx,
        );
        if (instruction[1] !== null) heap[String(instruction[1])] = value;
        pc += 1;
        break;
      }
      case "m": {
        const value = callMethod(
          readEncodedOperand(
            instruction[2] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          ),
          String(instruction[3]),
          readEncodedOperands(instruction[4], heap, ctx, slotDefaults),
          ctx,
        );
        if (instruction[1] !== null) heap[String(instruction[1])] = value;
        pc += 1;
        break;
      }
      case "pg":
        heap[String(instruction[1])] = getEncodedProperty(
          instruction[2] as EncodedOperand,
          String(instruction[3]),
          heap,
          ctx,
          slotDefaults,
        );
        pc += 1;
        break;
      case "ag":
        heap[String(instruction[1])] = getArrayItem(
          readEncodedOperand(
            instruction[2] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          ),
          readEncodedOperand(
            instruction[3] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          ),
          ctx,
        );
        pc += 1;
        break;
      case "aa":
        setArrayItem(
          readEncodedOperand(
            instruction[1] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          ),
          readEncodedOperand(
            instruction[2] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          ),
          readEncodedOperand(
            instruction[3] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          ),
          ctx,
        );
        pc += 1;
        break;
      case "ps":
        setProperty(
          readEncodedOperand(
            instruction[1] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          ),
          String(instruction[2]),
          readEncodedOperand(
            instruction[3] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          ),
          ctx,
        );
        pc += 1;
        break;
      case "r": {
        if (instruction[1] !== null && instruction[2] !== null) {
          heap[String(instruction[2])] = readEncodedOperand(
            instruction[1] as EncodedOperand,
            heap,
            ctx,
            slotDefaults,
          );
        }
        return { heap, logs: [...debugLogs] };
      }
      case "unsupported":
        throw runtimeError(
          `Unsupported TAC instruction kind '${String(instruction[1])}'`,
          ctx,
        );
      default:
        throw runtimeError(`Unsupported encoded TAC op '${op}'`, ctx);
    }
  }
}

function getArrayItem(
  array: unknown,
  index: unknown,
  ctx: TsIrContext,
): unknown {
  if (!Array.isArray(array)) {
    throw runtimeError("Array access target is not an array", ctx);
  }
  return array[castInt(index)];
}

function setArrayItem(
  array: unknown,
  index: unknown,
  value: unknown,
  ctx: TsIrContext,
): void {
  if (!Array.isArray(array)) {
    throw runtimeError("Array assignment target is not an array", ctx);
  }
  array[castInt(index)] = value;
}

function readEncodedOperands(
  operands: unknown,
  heap: Record<string, unknown>,
  ctx: TsIrContext,
  slotDefaults: Readonly<Record<string, string>>,
): unknown[] {
  if (!Array.isArray(operands)) {
    throw runtimeError("Encoded TAC operands are not an array", ctx);
  }
  return operands.map((operand) =>
    readEncodedOperand(operand as EncodedOperand, heap, ctx, slotDefaults),
  );
}

function getEncodedProperty(
  operand: EncodedOperand,
  property: string,
  heap: Record<string, unknown>,
  ctx: TsIrContext,
  slotDefaults: Readonly<Record<string, string>>,
): unknown {
  const value = readEncodedOperand(operand, heap, ctx, slotDefaults);
  if (operand[0] === "s" && Number.isFinite(Number(value))) {
    const resolved = resolveInlineFieldSlot(
      `${String(operand[1])}_${property}`,
      heap,
    );
    if (resolved.found) {
      return readSlot(resolved.value, `${String(operand[1])}_${property}`, ctx);
    }
  }
  return getProperty(value, property, ctx);
}

function readEncodedOperand(
  operand: EncodedOperand,
  heap: Record<string, unknown>,
  ctx: TsIrContext,
  slotDefaults: Readonly<Record<string, string>> = {},
): unknown {
  switch (operand[0]) {
    case "s": {
      const slot = String(operand[1]);
      if (Object.hasOwn(heap, slot)) {
        return heap[slot];
      }
      if (heap[slot] === undefined && slot.endsWith("__inited")) {
        return 0;
      }
      if (heap[slot] === undefined) {
        const resolved = resolveInlineFieldSlot(slot, heap);
        if (resolved.found) return resolved.value;
      }
      if (isInlineInstanceFieldSlot(slot)) {
        return undefined;
      }
      if (heap[slot] === undefined && slot in slotDefaults) {
        return defaultValueForCode(slotDefaults[slot]);
      }
      if (heap[slot] === undefined && slot.endsWith("_stackInit")) {
        return false;
      }
      if (heap[slot] === undefined && slot === "options") {
        return null;
      }
      if (heap[slot] === undefined && slot.startsWith("options_")) {
        return 0;
      }
      if (heap[slot] === undefined && slot === "lastAddedTile") {
        return null;
      }
      if (
        heap[slot] === undefined &&
        (slot.startsWith("__inst_") ||
          slot.startsWith("__viface_") ||
          slot.startsWith("__inline_") ||
          slot.startsWith("__inline_ret_") ||
          slot.startsWith("__inlineRec_") ||
          slot.startsWith("__inlineRecInst_") ||
          slot.startsWith("__outline_") ||
          slot.startsWith("__tmp"))
      ) {
        return 0;
      }
      return readSlot(heap[slot], slot, ctx);
    }
    case "k":
      return operand[1];
    case "bi":
      return BigInt(String(operand[1]));
    case "label":
      return String(operand[1]);
    default:
      throw runtimeError(
        `Unsupported encoded TAC operand '${operand[0]}'`,
        ctx,
      );
  }
}

function defaultValueForCode(code: string | undefined): unknown {
  switch (code) {
    case "z":
      return 0;
    case "f":
      return false;
    case "s":
      return "";
    case "n":
      return null;
    case "dt":
      return dataToken(null);
    default:
      return undefined;
  }
}

function resolveInlineFieldSlot(
  slot: string,
  heap: Record<string, unknown>,
): { readonly found: boolean; readonly value?: unknown } {
  const tempAlias = /^__tmp(\d+)_(.+)$/.exec(slot);
  if (tempAlias) {
    const tempId = tempAlias[1];
    const suffix = tempAlias[2];
    if (tempId === undefined || suffix === undefined) {
      return { found: false };
    }
    const resolved = resolveInlineFieldFromParent(`__t${tempId}`, suffix, heap);
    if (resolved.found) return resolved;
  }

  let bestParent = "";
  for (const [name, value] of Object.entries(heap)) {
    if (
      !slot.startsWith(`${name}_`) ||
      value === undefined ||
      value === null ||
      value === NULL_HANDLE ||
      !Number.isFinite(Number(value))
    ) {
      continue;
    }
    if (name.length > bestParent.length) {
      bestParent = name;
    }
  }
  if (!bestParent) return { found: false };

  const suffix = slot.slice(bestParent.length + 1);
  return resolveInlineFieldFromParent(bestParent, suffix, heap);
}

function resolveInlineFieldFromParent(
  parent: string,
  suffix: string,
  heap: Record<string, unknown>,
  seen: ReadonlySet<string> = new Set(),
): { readonly found: boolean; readonly value?: unknown } {
  if (seen.has(parent)) return { found: false };
  const nextSeen = new Set(seen);
  nextSeen.add(parent);

  const directAlias = `${parent}_${suffix}`;
  if (Object.hasOwn(heap, directAlias)) {
    return { found: true, value: heap[directAlias] };
  }

  const copiedFrom = heap[aliasSlot(parent)];
  if (typeof copiedFrom === "string") {
    const resolved = resolveInlineFieldFromParent(
      copiedFrom,
      suffix,
      heap,
      nextSeen,
    );
    if (resolved.found) return resolved;
  }

  const bestHandle = heap[parent];
  if (
    bestHandle === undefined ||
    bestHandle === null ||
    bestHandle === NULL_HANDLE ||
    !Number.isFinite(Number(bestHandle))
  ) {
    return { found: false };
  }

  for (const [name, value] of Object.entries(heap)) {
    if (!name.endsWith("__handle") || value !== bestHandle) continue;
    const prefix = name.slice(0, -"__handle".length);
    const candidate = `${prefix}_${suffix}`;
    if (Object.hasOwn(heap, candidate)) {
      return { found: true, value: heap[candidate] };
    }
  }
  return { found: false };
}

function aliasSlot(slot: string): string {
  return `__tsir_alias_${slot}`;
}

function isInlineInstanceFieldSlot(slot: string): boolean {
  return slot.startsWith("__inst_") && !slot.endsWith("__handle");
}

function snapshotInlineHandle(
  value: unknown,
  heap: Record<string, unknown> | undefined,
): InlineHandleSnapshot | undefined {
  if (typeof value !== "number" || value === NULL_HANDLE || !heap) {
    return undefined;
  }
  for (const [slot, slotValue] of Object.entries(heap)) {
    if (!slot.endsWith("__handle") || slotValue !== value) continue;
    const prefix = slot.slice(0, -"__handle".length);
    if (!prefix.startsWith("__inst_")) continue;
    const fields: Record<string, unknown> = {};
    const fieldPrefix = `${prefix}_`;
    for (const [fieldSlot, fieldValue] of Object.entries(heap)) {
      if (fieldSlot.startsWith(fieldPrefix) && fieldSlot !== slot) {
        fields[fieldSlot] = cloneSnapshotValue(fieldValue);
      }
    }
    if (Object.keys(fields).length === 0) return undefined;
    return { prefix, fields };
  }
  return undefined;
}

function restoreInlineSnapshot(value: unknown, ctx: TsIrContext): void {
  if (!ctx.heap || !isDataToken(value) || !value.__inlineSnapshot) return;
  for (const [fieldSlot, fieldValue] of Object.entries(
    value.__inlineSnapshot.fields,
  )) {
    ctx.heap[fieldSlot] = cloneSnapshotValue(fieldValue);
  }
}

function cloneSnapshotValue<T>(value: T): T {
  if (value instanceof DataDictionary) {
    return value;
  }
  if (value instanceof DataList) {
    return new DataList(
      value.items.map((item) => cloneSnapshotValue(item)),
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneSnapshotValue(item)) as T;
  }
  if (isDataToken(value)) {
    return {
      __kind: "DataToken",
      value: cloneSnapshotValue(value.value),
      ...(value.__inlineSnapshot
        ? { __inlineSnapshot: value.__inlineSnapshot }
        : {}),
    } as T;
  }
  if (value && typeof value === "object") {
    return { ...(value as Record<string, unknown>) } as T;
  }
  return value;
}

function isDataToken(value: unknown): value is DataToken<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __kind?: unknown }).__kind === "DataToken"
  );
}

function stableKey(value: unknown): string {
  if (isDataToken(value)) {
    return `token:${stableKey(value.value)}`;
  }
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "object") return `object:${JSON.stringify(value)}`;
  return `${kind}:${String(value)}`;
}

function describeValue(value: unknown): string {
  if (value instanceof DataList) return `DataList(${value.items.length})`;
  if (value instanceof DataDictionary) return `DataDictionary(${value.count})`;
  if (isDataToken(value)) return `DataToken(${describeValue(value.value)})`;
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return `${typeof value}:${String(value)}`;
}

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
};

export type TsIrContext = {
  readonly pc?: number;
  readonly instruction?: string;
  readonly extern?: string;
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
    return found.value;
  }

  containsKey(key: K): boolean {
    return this.entries.has(stableKey(key));
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

export function dataToken<T = unknown>(value: T): DataToken<T> {
  return { __kind: "DataToken", value };
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
  return left === right;
}

export function nullEquals(value: unknown): boolean {
  return value === null || value === NULL_HANDLE;
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
  return list.items[i] as T;
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
      return dataToken(args[0]);
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
  throw runtimeError(`Unsupported method '${method}'`, ctx);
}

export function getProperty(
  object: unknown,
  property: string,
  ctx: TsIrContext = {},
): unknown {
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
      case "DataDictionary":
      case "Reference":
      case "String":
      case "Boolean":
      case "Double":
      case "Int":
        return object.value;
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

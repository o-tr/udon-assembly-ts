import * as fs from "node:fs";
import * as ts from "typescript";
import { stripModuleQualifier } from "./symbol_naming.js";

type Step10MetricEntry = {
  count: number;
};

/**
 * Diagnostic metadata captured for the *first* occurrence of each
 * step-10 typeText. Used to disambiguate Step D / Step C leak paths
 * (see z/step10_analysis.md). All fields are optional — emitted only
 * when the relevant TypeScript flags are set on the source type.
 */
type Step10MetricSample = {
  typeFlags: string;
  objectFlags?: string;
  aliasName?: string | null;
  aliasTargetFlags?: string | null;
  hasSymbol: boolean;
  targetSymbolName?: string | null;
  unionMemberFlags?: string[];
};

const TARGET_CATEGORIES = new Set([
  "union",
  "simple-name",
  "anon-object",
  "other",
]);

const TOP_TYPES_HARD_CAP = 2000;
const TOP_TYPES_BY_COUNT = Math.min(200, TOP_TYPES_HARD_CAP);

let typeFlagTable: [number, string][] | null = null;
let objectFlagTable: [number, string][] | null = null;

function buildSingleBitTable(
  enumObject: Record<string, string | number>,
): [number, string][] {
  const out: [number, string][] = [];
  for (const [name, value] of Object.entries(enumObject)) {
    if (typeof value !== "number") continue;
    if (value === 0) continue;
    if ((value & (value - 1)) !== 0) continue;
    out.push([value, name]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

function flagNames(
  flags: number | undefined,
  table: [number, string][],
): string {
  if (flags === undefined || flags === 0) return "0";
  // Coerce to unsigned 32-bit so a future TS flag at bit 31 doesn't
  // surface as a negative residual in the diagnostic output.
  const unsigned = flags >>> 0;
  const names: string[] = [];
  let residual = unsigned;
  for (const [bit, name] of table) {
    if ((unsigned & bit) !== 0) {
      names.push(name);
      residual &= ~bit;
    }
  }
  if (residual !== 0) names.push(`0x${(residual >>> 0).toString(16)}`);
  return names.join("|");
}

function getTypeFlagTable(): [number, string][] {
  if (!typeFlagTable) {
    typeFlagTable = buildSingleBitTable(
      ts.TypeFlags as unknown as Record<string, string | number>,
    );
  }
  return typeFlagTable;
}

function getObjectFlagTable(): [number, string][] {
  if (!objectFlagTable) {
    objectFlagTable = buildSingleBitTable(
      ts.ObjectFlags as unknown as Record<string, string | number>,
    );
  }
  return objectFlagTable;
}

function buildSample(
  type: ts.Type,
  checker: ts.TypeChecker,
): Step10MetricSample {
  const tFlags = type.flags;
  const sample: Step10MetricSample = {
    typeFlags: flagNames(tFlags, getTypeFlagTable()),
    hasSymbol: !!type.getSymbol(),
  };

  let objFlags: number | undefined;
  if (tFlags & ts.TypeFlags.Object) {
    objFlags = (type as ts.ObjectType).objectFlags;
    sample.objectFlags = flagNames(objFlags, getObjectFlagTable());
  }

  const aliasSymbol = type.aliasSymbol;
  if (aliasSymbol) {
    sample.aliasName = stripModuleQualifier(
      checker.symbolToString(aliasSymbol),
    );
    if (aliasSymbol.flags & ts.SymbolFlags.TypeAlias) {
      const declared = checker.getDeclaredTypeOfSymbol(aliasSymbol);
      sample.aliasTargetFlags = flagNames(declared.flags, getTypeFlagTable());
    } else {
      sample.aliasTargetFlags = null;
    }
  } else {
    sample.aliasName = null;
    sample.aliasTargetFlags = null;
  }

  if (objFlags !== undefined && objFlags & ts.ObjectFlags.Reference) {
    const target = (type as ts.TypeReference).target;
    const targetSym = target?.getSymbol();
    sample.targetSymbolName = targetSym
      ? stripModuleQualifier(checker.symbolToString(targetSym))
      : null;
  } else {
    sample.targetSymbolName = null;
  }

  if (tFlags & ts.TypeFlags.Union) {
    const union = type as ts.UnionType;
    sample.unionMemberFlags = union.types.map((t) =>
      flagNames(t.flags, getTypeFlagTable()),
    );
  }

  return sample;
}

const STEP10_METRICS_ENV = "UDON_TS_STEP10_METRICS";
const STEP10_METRICS_FILE_ENV = "UDON_TS_STEP10_METRICS_FILE";
const PERIODIC_FLUSH_INTERVAL_MS = 5000;
// Synchronous workloads (BatchTranspiler) starve the event loop, so the
// setInterval flush below never fires. Force a write every N records as a
// crash-survival floor — OOMs still leave a file with the latest snapshot.
const RECORD_FLUSH_THRESHOLD = 5000;

let cachedEnabled: boolean | null = null;
export function isStep10MetricsEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  const value = process.env[STEP10_METRICS_ENV];
  cachedEnabled = value !== undefined && value !== "0" && value !== "false";
  return cachedEnabled;
}

/** Test-only: clear the cached env-var snapshot so a test can flip
 *  UDON_TS_STEP10_METRICS and observe the new value. */
export function __resetStep10MetricsCacheForTest(): void {
  cachedEnabled = null;
}

function getMetricsFilePath(): string {
  return process.env[STEP10_METRICS_FILE_ENV] ?? "step10_metrics.json";
}

class Step10MetricsCollector {
  private readonly counts = new Map<string, Step10MetricEntry>();
  private readonly samples = new Map<string, Step10MetricSample>();
  private hooked = false;
  private periodicTimer: NodeJS.Timeout | null = null;
  private recordsSinceFlush = 0;

  record(typeText: string, type?: ts.Type, checker?: ts.TypeChecker): void {
    if (!this.isEnabled()) return;
    this.ensureHooked();
    const key = typeText.trim();
    const existing = this.counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      this.counts.set(key, { count: 1 });
      if (type && checker) {
        this.samples.set(key, buildSample(type, checker));
      }
    }
    this.recordsSinceFlush += 1;
    if (this.recordsSinceFlush >= RECORD_FLUSH_THRESHOLD) {
      this.recordsSinceFlush = 0;
      this.flushToFile();
    }
  }

  /** Returns true on a successful write, false if there was nothing to write
   *  or if the write itself failed. The exit handler uses this to avoid
   *  printing a "written to" line when the file isn't actually on disk. */
  flushToFile(): boolean {
    const summary = this.flush();
    if (summary === null) return false;
    try {
      fs.writeFileSync(getMetricsFilePath(), summary);
      return true;
    } catch (e) {
      console.error("[step10-metrics] write failed:", e);
      return false;
    }
  }

  flush(): string | null {
    if (!this.isEnabled() || this.counts.size === 0) return null;

    const entries = [...this.counts.entries()]
      .map(([typeText, entry]) => ({
        typeText,
        count: entry.count,
        category: categorizeStep10Type(typeText),
        sample: this.samples.get(typeText),
      }))
      .sort(
        (a, b) => b.count - a.count || a.typeText.localeCompare(b.typeText),
      );

    const categories = new Map<string, number>();
    for (const entry of entries) {
      categories.set(
        entry.category,
        (categories.get(entry.category) ?? 0) + entry.count,
      );
    }

    // Pick the top-N by count, then union with all entries in target
    // categories so D/C signal entries aren't truncated by a long tail
    // of generic-shape entries. Cap the union at TOP_TYPES_HARD_CAP so
    // pathological fixtures can't blow up the output unboundedly.
    const seen = new Set<string>();
    const selected: typeof entries = [];
    for (const e of entries.slice(0, TOP_TYPES_BY_COUNT)) {
      seen.add(e.typeText);
      selected.push(e);
    }
    const targetCategoryEntries = entries.filter(
      (e) => TARGET_CATEGORIES.has(e.category) && !seen.has(e.typeText),
    );
    let droppedTargetCategoryCount = 0;
    for (const e of targetCategoryEntries) {
      if (selected.length >= TOP_TYPES_HARD_CAP) {
        droppedTargetCategoryCount += 1;
        continue;
      }
      selected.push(e);
    }
    selected.sort(
      (a, b) => b.count - a.count || a.typeText.localeCompare(b.typeText),
    );

    return JSON.stringify(
      {
        totalHits: entries.reduce((sum, entry) => sum + entry.count, 0),
        uniqueTypes: entries.length,
        categories: Object.fromEntries([...categories.entries()].sort()),
        droppedTargetCategoryCount,
        topTypes: selected,
      },
      null,
      2,
    );
  }

  // The handlers below are installed only when metrics mode is on and only
  // once per process. They flush data and then defer to the host's default
  // behavior (re-emitting the signal / re-throwing the error) so we don't
  // hijack control from CLI consumers that have their own cleanup.
  private ensureHooked(): void {
    if (this.hooked) return;
    this.hooked = true;
    this.periodicTimer = setInterval(
      () => this.flushToFile(),
      PERIODIC_FLUSH_INTERVAL_MS,
    );
    this.periodicTimer.unref?.();
    process.on("exit", () => {
      const written = this.flushToFile();
      if (written) {
        console.error(`[step10-metrics] written to ${getMetricsFilePath()}`);
      }
    });
    const signalExitCodes: Record<NodeJS.Signals, number> = {
      SIGINT: 130,
      SIGTERM: 143,
    } as Record<NodeJS.Signals, number>;
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => {
        this.flushToFile();
        process.exitCode = signalExitCodes[sig];
        process.kill(process.pid, sig);
      });
    }
    process.once("uncaughtException", (err) => {
      this.flushToFile();
      // Re-throw on next tick so node's default handler reports + exits.
      process.nextTick(() => {
        throw err;
      });
    });
  }

  private isEnabled(): boolean {
    return isStep10MetricsEnabled();
  }

  /** Test-only: clear collector state so each test starts from scratch. */
  __clearForTest(): void {
    this.counts.clear();
    this.samples.clear();
    this.recordsSinceFlush = 0;
  }
}

function categorizeStep10Type(typeText: string): string {
  const trimmed = typeText.trim();
  // Strip a leading `readonly ` modifier of any whitespace flavor before
  // recursing so "readonly\tFoo[]" categorizes as "array".
  const readonlyMatch = trimmed.match(/^readonly\s+/);
  if (readonlyMatch) {
    return categorizeStep10Type(trimmed.slice(readonlyMatch[0].length));
  }
  // Structural shapes first — `Promise<() => void>` should categorize as
  // "promise", not "function", and `Map<K, A | B>` should not be confused
  // with a heterogeneous union.
  if (
    /^Array<.+>$/.test(trimmed) ||
    /^ReadonlyArray<.+>$/.test(trimmed) ||
    /\[\]$/.test(trimmed)
  ) {
    return "array";
  }
  if (/^(Map|Dictionary|UdonDictionary)<.+>$/.test(trimmed)) {
    return "map";
  }
  if (/^(Set|UdonSet)<.+>$/.test(trimmed)) {
    return "set";
  }
  if (/^Promise<.+>$/.test(trimmed) || /^PromiseLike<.+>$/.test(trimmed)) {
    return "promise";
  }
  // Generic catch-all (Foo<...>, Foo.Bar<...>): only when the outer `<...>`
  // spans the entire suffix at nesting depth zero. A naive regex would
  // bucket `Foo<T> & Bar<U>` as "generic" because the string ends in `>`.
  if (isPlainGenericApplication(trimmed)) {
    return "generic";
  }
  // Function: a top-level `=>` (i.e. one that is not nested inside `<...>`,
  // `(...)`, `[...]`, `{...}` or quotes). A simpler `=>` test would put
  // `Map<string, () => void>` into "function" instead of "map", and the
  // structural buckets above already absorb the well-formed cases.
  if (hasTopLevelArrow(trimmed)) {
    return "function";
  }
  // Tuple before union/anon-object — `[A, B] | C` is still a union, but a
  // bare `[A, B]` is a tuple.
  if (/^\[.+\]$/.test(trimmed) && hasMatchingOuterBrackets(trimmed, "[", "]")) {
    return "tuple";
  }
  // Top-level `|` and `&` checks come before the brace-wrapped object check
  // because `{ a: T } | { b: U }` is a union of objects, not an anon-object.
  if (hasTopLevelToken(trimmed, "|")) {
    return "union";
  }
  if (hasTopLevelToken(trimmed, "&")) {
    return "intersection";
  }
  if (/^\{.*\}$/.test(trimmed) && hasMatchingOuterBrackets(trimmed, "{", "}")) {
    return "anon-object";
  }
  // Plain identifier (with optional `.`-qualified namespace): a class/interface
  // whose symbol path didn't resolve in earlier steps. Most actionable bucket.
  if (
    /^(?:\p{ID_Start}|[$_])(?:\p{ID_Continue}|[$_])*(?:\.(?:\p{ID_Start}|[$_])(?:\p{ID_Continue}|[$_])*)*$/u.test(
      trimmed,
    )
  ) {
    return "simple-name";
  }
  return "other";
}

/** True if `text` is `<HeadIdent>(<.<Ident>)*<...>` and the outer `<...>` pair
 *  is the entire suffix — i.e. no top-level `|`, `&`, `=>`, or trailing
 *  characters after the closing `>`. Discriminates real generic applications
 *  like `Foo.Bar<T>` from `Foo<T> & Bar<U>` whose tail just happens to end
 *  with `>`. */
function isPlainGenericApplication(text: string): boolean {
  // Head must be an identifier (optionally dotted). Walk until first `<`.
  let i = 0;
  if (i >= text.length) return false;
  const isHeadStart = (c: string) => /[\p{ID_Start}$_]/u.test(c);
  const isHeadCont = (c: string) => /[\p{ID_Continue}$_.]/u.test(c);
  if (!isHeadStart(text[i])) return false;
  i += 1;
  while (i < text.length && isHeadCont(text[i])) i += 1;
  if (i === 0 || i >= text.length || text[i] !== "<") return false;
  // Outer `<` at i; walk to the matching `>` at depth 0. `=>` is not a
  // closing angle bracket — skip its `>` to avoid prematurely closing the
  // outer span on inputs like `Foo<(x: T) => U>`.
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === "<") depth += 1;
    else if (ch === ">" && (j === 0 || text[j - 1] !== "=")) {
      depth -= 1;
      if (depth === 0) {
        // Must be the last character — anything after disqualifies.
        return j === text.length - 1;
      }
    }
  }
  return false;
}

/** True if the outer `[...]` (or `{...}`) span the whole string, i.e. the
 *  first opener and last closer pair up at nesting depth zero in between. */
function hasMatchingOuterBrackets(
  text: string,
  open: string,
  close: string,
): boolean {
  if (text.length < 2 || text[0] !== open || text[text.length - 1] !== close) {
    return false;
  }
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0 && i !== text.length - 1) return false;
    }
  }
  return depth === 0;
}

function hasTopLevelArrow(text: string): boolean {
  return findTopLevelIndex(text, "=>") !== -1;
}

function hasTopLevelToken(text: string, token: string): boolean {
  return findTopLevelIndex(text, token) !== -1;
}

/** Index of the first occurrence of `token` at bracket-nesting depth zero,
 *  ignoring contents inside `<>`, `()`, `[]`, `{}`, and string literals. */
function findTopLevelIndex(text: string, token: string): number {
  const len = text.length;
  let i = 0;
  let angle = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  while (i < len) {
    const ch = text[i];
    // Skip string literals — typeToString preserves them for literal types.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < len && text[i] !== quote) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "<") angle += 1;
    else if (ch === ">") {
      // `=>` is not a closing angle bracket — peek behind.
      if (i > 0 && text[i - 1] === "=") {
        // it's part of `=>`
      } else if (angle > 0) {
        angle -= 1;
      }
    } else if (ch === "(") paren += 1;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") bracket += 1;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "{") brace += 1;
    else if (ch === "}") brace = Math.max(0, brace - 1);

    if (
      angle === 0 &&
      paren === 0 &&
      bracket === 0 &&
      brace === 0 &&
      text.startsWith(token, i)
    ) {
      return i;
    }
    i += 1;
  }
  return -1;
}

export const step10Metrics = new Step10MetricsCollector();

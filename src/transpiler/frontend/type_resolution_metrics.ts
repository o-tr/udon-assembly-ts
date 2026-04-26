import * as fs from "node:fs";

type Step10MetricEntry = {
  count: number;
};

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
  cachedEnabled =
    value !== undefined && value !== "0" && value !== "false";
  return cachedEnabled;
}

function getMetricsFilePath(): string {
  return process.env[STEP10_METRICS_FILE_ENV] ?? "step10_metrics.json";
}

class Step10MetricsCollector {
  private readonly counts = new Map<string, Step10MetricEntry>();
  private hooked = false;
  private periodicTimer: NodeJS.Timeout | null = null;
  private recordsSinceFlush = 0;

  record(typeText: string): void {
    if (!this.isEnabled()) return;
    this.ensureHooked();
    const key = typeText.trim();
    const existing = this.counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      this.counts.set(key, { count: 1 });
    }
    this.recordsSinceFlush += 1;
    if (this.recordsSinceFlush >= RECORD_FLUSH_THRESHOLD) {
      this.recordsSinceFlush = 0;
      this.flushToFile();
    }
  }

  flushToFile(): void {
    const summary = this.flush();
    if (summary === null) return;
    try {
      fs.writeFileSync(getMetricsFilePath(), summary);
    } catch (e) {
      console.error("[step10-metrics] write failed:", e);
    }
  }

  flush(): string | null {
    if (!this.isEnabled() || this.counts.size === 0) return null;

    const entries = [...this.counts.entries()]
      .map(([typeText, entry]) => ({
        typeText,
        count: entry.count,
        category: categorizeStep10Type(typeText),
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

    return JSON.stringify(
      {
        totalHits: entries.reduce((sum, entry) => sum + entry.count, 0),
        uniqueTypes: entries.length,
        categories: Object.fromEntries([...categories.entries()].sort()),
        topTypes: entries.slice(0, 200),
      },
      null,
      2,
    );
  }

  private ensureHooked(): void {
    if (this.hooked) return;
    this.hooked = true;
    // Periodic flush to a file path so OOM / hard crashes don't lose data.
    this.periodicTimer = setInterval(
      () => this.flushToFile(),
      PERIODIC_FLUSH_INTERVAL_MS,
    );
    this.periodicTimer.unref?.();
    process.on("exit", () => {
      this.flushToFile();
      const summary = this.flush();
      if (summary) {
        console.error(`[step10-metrics] written to ${getMetricsFilePath()}`);
      }
    });
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        this.flushToFile();
        process.exit(1);
      });
    }
    process.on("uncaughtException", (err) => {
      this.flushToFile();
      console.error(err);
      process.exit(1);
    });
  }

  private isEnabled(): boolean {
    return isStep10MetricsEnabled();
  }
}

function categorizeStep10Type(typeText: string): string {
  const trimmed = typeText.trim();
  if (/^readonly\s+/.test(trimmed)) {
    return categorizeStep10Type(trimmed.slice(9));
  }
  // function: anything containing `=>` at top level (heuristic: presence is enough,
  // since function types are a closed shape with no nested `=>` semantic).
  if (/=>/.test(trimmed)) {
    return "function";
  }
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
  if (/^Promise<.+>$/.test(trimmed) || /PromiseLike<.+>$/.test(trimmed)) {
    return "promise";
  }
  // tuple: bracketed list like [A, B] — distinct from array which is `T[]`.
  if (/^\[.+\]$/.test(trimmed) && !/\]$/.test(trimmed.slice(0, -2))) {
    return "tuple";
  }
  if (/^\{.*\}$/.test(trimmed)) {
    return "anon-object";
  }
  if (/\|/.test(trimmed)) {
    return "union";
  }
  if (/&/.test(trimmed)) {
    return "intersection";
  }
  if (/^[^<]+<.+>$/.test(trimmed)) {
    return "generic";
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

export const step10Metrics = new Step10MetricsCollector();

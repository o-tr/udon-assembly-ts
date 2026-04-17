/**
 * Transpiler error types and helpers
 */

export type TranspileErrorCode =
  | "UnsupportedSyntax"
  | "UnsupportedFeature"
  | "TypeError"
  | "InternalError";

export type TranspileWarningCode =
  | "ErasedReturnInline"
  | "InlineSoAEpilogue"
  | "InlineRecursiveReentry"
  | "InlineErasedReturnType"
  | "AllInlineInterfaceFallback"
  | "D3DispatchFallback"
  | "SoAFieldListMissing"
  | "RecursiveSelfCallOvercount";

export interface TranspileErrorLocation {
  filePath: string;
  line: number;
  column: number;
}

export interface TranspileWarning {
  code: TranspileWarningCode;
  message: string;
  location: TranspileErrorLocation;
  context?: {
    className?: string;
    methodName?: string;
  };
}

export function formatLocation(loc: TranspileErrorLocation): string {
  // Callers may pass {line: 0, column: 0} as a sentinel when the warning
  // has no source node (e.g. a between-pass diagnostic). Many editors and
  // CI tools treat `path:0:0` as invalid, so emit just the file path in
  // that case. Real locations are always 1-based.
  if (loc.line === 0 && loc.column === 0) return loc.filePath;
  return `${loc.filePath}:${loc.line}:${loc.column}`;
}

export function formatContext(context: TranspileWarning["context"]): string {
  if (!context) return "";
  const { className, methodName } = context;
  if (className && methodName) return ` (${className}.${methodName})`;
  if (className) return ` (${className})`;
  if (methodName) return ` (${methodName})`;
  return "";
}

export function formatWarnings(warnings: TranspileWarning[]): string {
  if (warnings.length === 0) return "";
  const header = `Transpile produced ${warnings.length} warning(s):`;
  const lines = warnings.map((w) => {
    const loc = formatLocation(w.location);
    const ctx = formatContext(w.context);
    return `- [${w.code}] ${loc}${ctx} ${w.message}`;
  });
  return [header, ...lines].join("\n");
}

export class TranspileError extends Error {
  readonly code: TranspileErrorCode;
  readonly location: TranspileErrorLocation;
  readonly suggestion?: string;

  constructor(
    code: TranspileErrorCode,
    message: string,
    location: TranspileErrorLocation,
    suggestion?: string,
  ) {
    super(message);
    this.name = "TranspileError";
    this.code = code;
    this.location = location;
    this.suggestion = suggestion;
  }
}

export class DuplicateTopLevelConstError extends Error {
  readonly constName: string;
  readonly locationA: TranspileErrorLocation;
  readonly locationB: TranspileErrorLocation;

  constructor(
    constName: string,
    locationA: TranspileErrorLocation,
    locationB: TranspileErrorLocation,
  ) {
    super(
      `Top-level const "${constName}" is defined in both "${locationA.filePath}" and "${locationB.filePath}". Rename one to avoid ambiguity.`,
    );
    this.name = "DuplicateTopLevelConstError";
    this.constName = constName;
    this.locationA = locationA;
    this.locationB = locationB;
  }

  toTranspileErrors(): [TranspileError, TranspileError] {
    const msg = `Duplicate top-level const "${this.constName}"`;
    const suggestion = "Rename one of the conflicting declarations";
    return [
      new TranspileError(
        "TypeError",
        `${msg} (also in "${this.locationB.filePath}")`,
        this.locationA,
        suggestion,
      ),
      new TranspileError(
        "TypeError",
        `${msg} (also in "${this.locationA.filePath}")`,
        this.locationB,
        suggestion,
      ),
    ];
  }
}

export class AggregateTranspileError extends Error {
  readonly errors: TranspileError[];

  constructor(errors: TranspileError[]) {
    super(AggregateTranspileError.formatMessage(errors));
    this.name = "AggregateTranspileError";
    this.errors = errors;
  }

  private static formatMessage(errors: TranspileError[]): string {
    const header = `Transpile failed with ${errors.length} error(s):`;
    const lines = errors.map((err) => {
      const loc = formatLocation(err.location);
      const suggestion = err.suggestion ? ` (hint: ${err.suggestion})` : "";
      return `- [${err.code}] ${loc} ${err.message}${suggestion}`;
    });
    return [header, ...lines].join("\n");
  }
}

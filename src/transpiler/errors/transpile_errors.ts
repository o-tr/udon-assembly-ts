/**
 * Transpiler error types and helpers
 */

export type TranspileErrorCode =
  | "UnsupportedSyntax"
  | "UnsupportedFeature"
  | "TypeError"
  | "InternalError";

export interface TranspileErrorLocation {
  filePath: string;
  line: number;
  column: number;
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
      new TranspileError("TypeError", `${msg} (also in "${this.locationB.filePath}")`, this.locationA, suggestion),
      new TranspileError("TypeError", `${msg} (also in "${this.locationA.filePath}")`, this.locationB, suggestion),
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
      const loc = `${err.location.filePath}:${err.location.line}:${err.location.column}`;
      const suggestion = err.suggestion ? ` (hint: ${err.suggestion})` : "";
      return `- [${err.code}] ${loc} ${err.message}${suggestion}`;
    });
    return [header, ...lines].join("\n");
  }
}

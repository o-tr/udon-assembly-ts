/**
 * Error collector for transpiler
 */

import {
  AggregateTranspileError,
  type TranspileError,
  type TranspileWarning,
} from "./transpile_errors.js";

export class ErrorCollector {
  private errors: TranspileError[] = [];
  private warnings: TranspileWarning[] = [];

  add(error: TranspileError): void {
    this.errors.push(error);
  }

  addWarning(warning: TranspileWarning): void {
    this.warnings.push(warning);
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  getErrors(): TranspileError[] {
    return [...this.errors];
  }

  getWarnings(): TranspileWarning[] {
    return [...this.warnings];
  }

  throwIfErrors(): void {
    if (this.errors.length > 0) {
      throw new AggregateTranspileError(this.errors);
    }
  }
}

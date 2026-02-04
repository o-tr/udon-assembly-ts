/**
 * Error collector for transpiler
 */

import {
  AggregateTranspileError,
  type TranspileError,
} from "./transpile_errors.js";

export class ErrorCollector {
  private errors: TranspileError[] = [];

  add(error: TranspileError): void {
    this.errors.push(error);
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  getErrors(): TranspileError[] {
    return [...this.errors];
  }

  throwIfErrors(): void {
    if (this.errors.length > 0) {
      throw new AggregateTranspileError(this.errors);
    }
  }
}

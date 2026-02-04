/**
 * Symbol table for tracking variables and their scopes
 */

import type { TypeSymbol } from "./type_symbols.js";
import type { SymbolInfo } from "./types.js";

/**
 * Symbol table manages scopes and symbol resolution
 */
export class SymbolTable {
  private scopes: Map<string, SymbolInfo>[];
  private currentScope: number;

  constructor() {
    this.scopes = [new Map()]; // Global scope
    this.currentScope = 0;
  }

  /**
   * Enter a new scope
   */
  enterScope(): void {
    this.currentScope++;
    this.scopes.push(new Map());
  }

  /**
   * Exit current scope
   */
  exitScope(): void {
    if (this.currentScope > 0) {
      this.scopes.pop();
      this.currentScope--;
    }
  }

  /**
   * Add a symbol to the current scope
   */
  addSymbol(
    name: string,
    type: TypeSymbol,
    isParameter = false,
    isConstant = false,
    initialValue?: unknown,
  ): void {
    const currentScopeMap = this.scopes[this.currentScope];
    if (currentScopeMap.has(name)) {
      throw new Error(
        `Symbol '${name}' already declared in current scope ${this.currentScope}`,
      );
    }

    currentScopeMap.set(name, {
      name,
      type,
      scope: this.currentScope,
      isParameter,
      isConstant,
      initialValue,
    });
  }

  /**
   * Lookup a symbol in current or parent scopes
   */
  lookup(name: string): SymbolInfo | undefined {
    // Search from current scope up to global scope
    for (let i = this.currentScope; i >= 0; i--) {
      const scope = this.scopes[i];
      const symbol = scope.get(name);
      if (symbol) {
        return symbol;
      }
    }
    return undefined;
  }

  /**
   * Check if a symbol exists in current scope only
   */
  hasInCurrentScope(name: string): boolean {
    return this.scopes[this.currentScope].has(name);
  }

  /**
   * Get all symbols in current scope
   */
  getCurrentScopeSymbols(): SymbolInfo[] {
    return Array.from(this.scopes[this.currentScope].values());
  }

  /**
   * Get all symbols across all scopes
   */
  getAllSymbols(): SymbolInfo[] {
    const allSymbols: SymbolInfo[] = [];
    for (const scope of this.scopes) {
      allSymbols.push(...Array.from(scope.values()));
    }
    return allSymbols;
  }

  /**
   * Get current scope level
   */
  getCurrentScope(): number {
    return this.currentScope;
  }
}

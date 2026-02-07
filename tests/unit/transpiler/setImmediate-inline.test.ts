import { describe, it, expect } from 'vitest';
import { TypeScriptToUdonTranspiler } from '../../../src/transpiler/index.js';

describe('setImmediate inline callback lowering', () => {
  it('inlines simple setImmediate(callback) without throwing and emits TAC/uasm', () => {
    const src = `
    class Foo {
      start() {
        setImmediate(() => {
          const x = 1 + 2;
          console.log(x);
        });
      }
    }
    `;

    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(src, { optimize: false });

    // Should produce TAC and UASM output strings
    expect(result).toBeDefined();
    expect(typeof result.tac).toBe('string');
    expect(typeof result.uasm).toBe('string');

    // Ensure the generated TAC/uasm contain evidence of the inlined body
    expect(result.tac).toContain('1 + 2');
    expect(result.uasm.length).toBeGreaterThan(0);
  });
});

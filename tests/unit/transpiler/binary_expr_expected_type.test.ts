import { beforeAll, describe, expect, it } from "vitest";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";

const INT32_ADD =
  "SystemInt32.__op_Addition__SystemInt32_SystemInt32__SystemInt32";
const DOUBLE_ADD =
  "SystemDouble.__op_Addition__SystemDouble_SystemDouble__SystemDouble";
const INT32_MUL =
  "SystemInt32.__op_Multiplication__SystemInt32_SystemInt32__SystemInt32";

const BASE = `
  import { UdonBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonDecorators";
  import { UdonSharpBehaviour } from "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour";
  import { UdonInt } from "@ootr/udon-assembly-ts/stubs/UdonTypes";
`;

describe("binary expression expected-type propagation", () => {
  let transpiler: TypeScriptToUdonTranspiler;

  beforeAll(() => {
    transpiler = new TypeScriptToUdonTranspiler();
  });

  // Fix 1: visitVariableDeclaration propagates declared type to RHS
  it("let x: UdonInt = 1 + 2 (both literals, Int32 context from decl)", () => {
    const result = transpiler.transpile(`${BASE}
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void { let x: UdonInt = 1 + 2; }
      }
    `);
    expect(result.uasm).toContain(INT32_ADD);
    expect(result.uasm).not.toContain(DOUBLE_ADD);
  });

  it("let x: UdonInt = a + b (two Int32 variables, no literal widening needed)", () => {
    const result = transpiler.transpile(`${BASE}
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void { let a: UdonInt = 3; let b: UdonInt = 4; let x: UdonInt = a + b; }
      }
    `);
    expect(result.uasm).toContain(INT32_ADD);
    expect(result.uasm).not.toContain(DOUBLE_ADD);
  });

  // Fix 2: compound ops propagate left operand type to right operand visit
  it("a += 1 (compound assignment, Int32 variable + literal)", () => {
    const result = transpiler.transpile(`${BASE}
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void { let a: UdonInt = 5; a += 1; }
      }
    `);
    expect(result.uasm).toContain(INT32_ADD);
    expect(result.uasm).not.toContain(DOUBLE_ADD);
  });

  // Fix 3: cross-propagation from left to right operand in main arithmetic path
  it("let x: UdonInt = a + 1 (left Int32 var cross-propagates to right literal)", () => {
    const result = transpiler.transpile(`${BASE}
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void { let a: UdonInt = 5; let x: UdonInt = a + 1; }
      }
    `);
    expect(result.uasm).toContain(INT32_ADD);
    expect(result.uasm).not.toContain(DOUBLE_ADD);
  });

  it("let x: number = a + 1 (float outer context, left Int32 var cross-propagates to right literal)", () => {
    const result = transpiler.transpile(`${BASE}
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void { let a: UdonInt = 5; let x: number = a + 1; }
      }
    `);
    expect(result.uasm).toContain(INT32_ADD);
    expect(result.uasm).not.toContain(DOUBLE_ADD);
  });

  // Fix 4: widenNumericOperands fallback retypes float constant to match int variable
  it("let x: number = 1 + a (float outer context, left literal must be retyped in widenNumericOperands)", () => {
    const result = transpiler.transpile(`${BASE}
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void { let a: UdonInt = 5; let x: number = 1 + a; }
      }
    `);
    expect(result.uasm).toContain(INT32_ADD);
    expect(result.uasm).not.toContain(DOUBLE_ADD);
  });

  // visitAssignmentExpression already set currentExpectedType (pre-existing, not a new fix)
  it("this.x = 1 + a (field assignment context, x:UdonInt)", () => {
    const result = transpiler.transpile(`${BASE}
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        x: UdonInt = 0;
        Start(): void { let a: UdonInt = 5; this.x = 1 + a; }
      }
    `);
    expect(result.uasm).toContain(INT32_ADD);
    expect(result.uasm).not.toContain(DOUBLE_ADD);
  });

  it("arr[i] = 1 + 2 (array element assignment, index + value both in Int32 context)", () => {
    const result = transpiler.transpile(`${BASE}
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        arr: UdonInt[] = [];
        Start(): void { let i: UdonInt = 0; this.arr[i] = 1 + 2; }
      }
    `);
    expect(result.uasm).toContain(INT32_ADD);
    expect(result.uasm).not.toContain(DOUBLE_ADD);
  });

  // Regression: fractional literals must NOT be silently truncated
  it("let x: UdonInt = a + 1 nested in multiplication stays Int32", () => {
    const result = transpiler.transpile(`${BASE}
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void { let a: UdonInt = 5; let x: UdonInt = (a + 1) * 2; }
      }
    `);
    expect(result.uasm).toContain(INT32_ADD);
    expect(result.uasm).toContain(INT32_MUL);
    expect(result.uasm).not.toContain(DOUBLE_ADD);
  });

  // Sanity: float literal + float variable should remain Double
  it("let x: number = 1.5 + a (fractional literal stays Double, no truncation)", () => {
    const result = transpiler.transpile(`${BASE}
      @UdonBehaviour()
      export class T extends UdonSharpBehaviour {
        Start(): void { let a: UdonInt = 5; let x: number = 1.5 + a; }
      }
    `);
    // 1.5 is not an integer — should NOT be silently retyped to Int32
    expect(result.uasm).not.toContain(INT32_ADD);
    // The addition must still happen via Double arithmetic
    expect(result.uasm).toContain(DOUBLE_ADD);
  });
});

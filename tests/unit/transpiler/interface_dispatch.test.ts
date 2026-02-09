import { beforeAll, describe, expect, it } from "vitest";
import { buildExternRegistryFromFiles } from "../../../src/transpiler/codegen/extern_registry";
import { ErrorCollector } from "../../../src/transpiler/errors/error_collector";
import { ClassRegistry } from "../../../src/transpiler/frontend/class_registry";
import { InheritanceValidator } from "../../../src/transpiler/frontend/inheritance_validator";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser/index.js";
import {
  ASTNodeKind,
  type ClassDeclarationNode,
  type InterfaceDeclarationNode,
} from "../../../src/transpiler/frontend/types.js";
import { TypeScriptToUdonTranspiler } from "../../../src/transpiler/index.js";
import { buildUdonBehaviourLayouts } from "../../../src/transpiler/ir/udon_behaviour_layout.js";

function buildLayoutsFromSource(source: string) {
  const parser = new TypeScriptParser();
  const ast = parser.parse(source);
  const registry = new ClassRegistry();
  registry.registerFromProgram(ast, "test.ts");

  const interfaceNodes = ast.statements.filter(
    (s): s is InterfaceDeclarationNode =>
      s.kind === ASTNodeKind.InterfaceDeclaration,
  );
  const classNodes = ast.statements.filter(
    (s): s is ClassDeclarationNode =>
      s.kind === ASTNodeKind.ClassDeclaration,
  );

  const classLikes = classNodes.map((cls) => ({
    name: cls.name,
    isUdonBehaviour: cls.decorators.some(
      (d) => d.name === "UdonBehaviour",
    ),
    methods: cls.methods.map((m) => ({
      name: m.name,
      parameters: m.parameters.map((p) => ({
        name: p.name,
        type: p.type,
      })),
      returnType: m.returnType,
      isPublic: m.isPublic,
    })),
  }));

  const ifaceLikes = interfaceNodes.map((iface) => ({
    name: iface.name,
    methods: iface.methods.map((m) => ({
      name: m.name,
      parameters: m.parameters.map((p) => ({
        name: p.name,
        type: p.type,
      })),
      returnType: m.returnType,
    })),
  }));

  const classImplements = registry.getClassImplementsMap();
  const layouts = buildUdonBehaviourLayouts(
    classLikes,
    ifaceLikes,
    classImplements,
  );

  return { layouts, registry, parser, ast };
}

describe("interface-based polymorphic dispatch", () => {
  beforeAll(() => {
    buildExternRegistryFromFiles([]);
  });

  it("generates IPC calls for interface method invocations", () => {
    const source = `
      interface IWeapon {
        attack(): void;
      }

      @UdonBehaviour()
      class GameManager extends UdonSharpBehaviour {
        weapon: IWeapon;

        Start(): void {
          this.weapon.attack();
        }
      }

      @UdonBehaviour()
      class Sword extends UdonSharpBehaviour implements IWeapon {
        attack(): void {
          const x: number = 1;
        }
      }
    `;

    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);

    // Should generate SendCustomEvent for the interface method call
    expect(result.tac).toContain("SendCustomEvent");
    // The method name should use interface-prefixed naming
    expect(result.tac).toContain("IWeapon_attack");
  });

  it("generates IPC with return value for interface methods", () => {
    const source = `
      interface IWeapon {
        getDamage(): number;
      }

      @UdonBehaviour()
      class GameManager extends UdonSharpBehaviour {
        weapon: IWeapon;

        Start(): void {
          const dmg: number = this.weapon.getDamage();
        }
      }

      @UdonBehaviour()
      class Sword extends UdonSharpBehaviour implements IWeapon {
        getDamage(): number {
          return 10;
        }
      }
    `;

    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);

    expect(result.tac).toContain("SendCustomEvent");
    expect(result.tac).toContain("GetProgramVariable");
    expect(result.tac).toContain("IWeapon_getDamage");
    expect(result.tac).toContain("IWeapon_getDamage__ret");
  });

  it("generates IPC with parameters for interface methods", () => {
    const source = `
      interface IWeapon {
        attack(power: number): void;
      }

      @UdonBehaviour()
      class GameManager extends UdonSharpBehaviour {
        weapon: IWeapon;

        Start(): void {
          this.weapon.attack(42);
        }
      }

      @UdonBehaviour()
      class Sword extends UdonSharpBehaviour implements IWeapon {
        attack(power: number): void {
          const x: number = power;
        }
      }
    `;

    const transpiler = new TypeScriptToUdonTranspiler();
    const result = transpiler.transpile(source);

    expect(result.tac).toContain("SetProgramVariable");
    expect(result.tac).toContain("SendCustomEvent");
    expect(result.tac).toContain("IWeapon_attack");
    expect(result.tac).toContain("IWeapon_attack__param_0");
  });

  it("unifies export names across multiple implementing classes", () => {
    const source = `
      interface IWeapon {
        attack(power: number): number;
      }

      @UdonBehaviour()
      class Sword extends UdonSharpBehaviour implements IWeapon {
        attack(power: number): number {
          return power * 2;
        }
      }

      @UdonBehaviour()
      class Bow extends UdonSharpBehaviour implements IWeapon {
        attack(power: number): number {
          return power * 3;
        }
      }
    `;

    const { layouts } = buildLayoutsFromSource(source);

    // Both Sword and Bow should use the same interface-prefixed export name
    const swordLayout = layouts.get("Sword");
    const bowLayout = layouts.get("Bow");
    expect(swordLayout).toBeDefined();
    expect(bowLayout).toBeDefined();

    const swordAttack = swordLayout!.get("attack");
    const bowAttack = bowLayout!.get("attack");
    expect(swordAttack).toBeDefined();
    expect(bowAttack).toBeDefined();

    // Both should use the unified interface name
    expect(swordAttack!.exportMethodName).toBe("IWeapon_attack");
    expect(bowAttack!.exportMethodName).toBe("IWeapon_attack");
    expect(swordAttack!.parameterExportNames[0]).toBe(
      "IWeapon_attack__param_0",
    );
    expect(bowAttack!.parameterExportNames[0]).toBe("IWeapon_attack__param_0");
    expect(swordAttack!.returnExportName).toBe("IWeapon_attack__ret");
    expect(bowAttack!.returnExportName).toBe("IWeapon_attack__ret");
  });

  it("preserves counter-based naming for non-interface methods", () => {
    const source = `
      interface IWeapon {
        attack(): void;
      }

      @UdonBehaviour()
      class Sword extends UdonSharpBehaviour implements IWeapon {
        attack(): void {
          const x: number = 1;
        }
        sharpen(level: number): void {
          const x: number = level;
        }
      }
    `;

    const { layouts } = buildLayoutsFromSource(source);

    const swordLayout = layouts.get("Sword");
    expect(swordLayout).toBeDefined();

    // Interface method uses interface naming
    const attackLayout = swordLayout!.get("attack");
    expect(attackLayout!.exportMethodName).toBe("IWeapon_attack");

    // Non-interface method uses counter-based naming
    const sharpenLayout = swordLayout!.get("sharpen");
    expect(sharpenLayout).toBeDefined();
    expect(sharpenLayout!.exportMethodName).toBe("__0_sharpen");
  });

  it("reports error when non-UdonBehaviour class implements UdonBehaviour interface", () => {
    const source = `
      interface IWeapon {
        attack(): void;
      }

      @UdonBehaviour()
      class Sword extends UdonSharpBehaviour implements IWeapon {
        attack(): void {
          const x: number = 1;
        }
      }

      class BadClass implements IWeapon {
        attack(): void {
          const x: number = 1;
        }
      }
    `;

    const errorCollector = new ErrorCollector();
    const parser = new TypeScriptParser(errorCollector);
    const ast = parser.parse(source, "test.ts");
    const registry = new ClassRegistry();
    registry.registerFromProgram(ast, "test.ts");

    const udonBehaviourInterfaceNames = new Set(
      registry.getUdonBehaviourInterfaces().keys(),
    );

    const validator = new InheritanceValidator(registry, errorCollector);
    validator.validateUdonBehaviourInterfaceConsistency(
      udonBehaviourInterfaceNames,
    );

    expect(errorCollector.hasErrors()).toBe(true);
    const errors = errorCollector.getErrors();
    const relevantError = errors.find(
      (e) =>
        e.message.includes("BadClass") &&
        e.message.includes("UdonBehaviour interface"),
    );
    expect(relevantError).toBeDefined();
  });

  it("interface layout is stored in layouts map", () => {
    const source = `
      interface IWeapon {
        attack(): void;
      }

      @UdonBehaviour()
      class Sword extends UdonSharpBehaviour implements IWeapon {
        attack(): void {
          const x: number = 1;
        }
      }
    `;

    const { layouts } = buildLayoutsFromSource(source);

    // Interface itself should have a layout in the map
    const ifaceLayout = layouts.get("IWeapon");
    expect(ifaceLayout).toBeDefined();
    const attackLayout = ifaceLayout!.get("attack");
    expect(attackLayout).toBeDefined();
    expect(attackLayout!.exportMethodName).toBe("IWeapon_attack");
  });
});

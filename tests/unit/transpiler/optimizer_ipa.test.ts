import { describe, expect, it } from "vitest";
import { ClassRegistry } from "../../../src/transpiler/frontend/class_registry";
import { MethodUsageAnalyzer } from "../../../src/transpiler/frontend/method_usage_analyzer";
import { TypeScriptParser } from "../../../src/transpiler/frontend/parser";
import {
  ASTNodeKind,
  type ClassDeclarationNode,
} from "../../../src/transpiler/frontend/types";
import { pruneProgramByMethodUsage } from "../../../src/transpiler/ir/optimizer/ipa";

describe("ipa pruning", () => {
  it("removes unreachable methods from program", () => {
    const source = `
class Helper {
  static used() {}
  static unused() {}
}

@UdonBehaviour
class Foo {
  Start() {
    Helper.used();
  }
}
`;

    const parser = new TypeScriptParser();
    const program = parser.parse(source, "<inline>");
    const registry = new ClassRegistry();
    registry.registerFromProgram(program, "<inline>");

    const usage = new MethodUsageAnalyzer(registry).analyze();
    const pruned = pruneProgramByMethodUsage(program, usage);

    const classNodes = pruned.statements.filter(
      (stmt): stmt is ClassDeclarationNode =>
        stmt.kind === ASTNodeKind.ClassDeclaration,
    );
    const helper = classNodes.find((node) => node.name === "Helper");
    if (!helper) {
      throw new Error("Expected Helper class in pruned program");
    }
    const helperNames = helper.methods.map((method) => method.name).sort();
    expect(helperNames).toEqual(["used"].sort());
  });
});

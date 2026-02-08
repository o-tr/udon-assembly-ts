import { describe, expect, it } from "vitest";
import type { CallAnalyzer } from "../../../src/transpiler/frontend/call_analyzer";
import type { ClassRegistry } from "../../../src/transpiler/frontend/class_registry";
import {
  buildHeapTree,
  buildHeapUsageTreeBreakdown,
} from "../../../src/transpiler/heap_limits";

function createMockRegistry(
  classes: Map<string, { isStub: boolean; isUdonBehaviour: boolean }>,
): ClassRegistry {
  return {
    isStub(className: string) {
      return classes.get(className)?.isStub ?? false;
    },
    getClass(className: string) {
      const entry = classes.get(className);
      if (!entry) return undefined;
      return {
        decorators: entry.isUdonBehaviour ? [{ name: "UdonBehaviour" }] : [],
      };
    },
  } as unknown as ClassRegistry;
}

function createMockCallAnalyzer(deps: Map<string, Set<string>>): CallAnalyzer {
  return {
    analyzeClass(className: string) {
      return {
        inlineClasses: deps.get(className) ?? new Set(),
        calledUdonBehaviours: new Set(),
      };
    },
  } as unknown as CallAnalyzer;
}

describe("buildHeapTree", () => {
  it("should build a simple tree with entry and one child", () => {
    const usageByClass = new Map([
      ["MyClass", 35],
      ["InlineA", 100],
    ]);
    const deps = new Map([["MyClass", new Set(["InlineA"])]]);
    const classes = new Map([
      ["MyClass", { isStub: false, isUdonBehaviour: false }],
      ["InlineA", { isStub: false, isUdonBehaviour: false }],
    ]);

    const { tree, claimed } = buildHeapTree(
      "MyClass",
      usageByClass,
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    expect(tree.className).toBe("MyClass");
    expect(tree.selfUsage).toBe(35);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.className).toBe("InlineA");
    expect(tree.children[0]?.selfUsage).toBe(100);
    expect(claimed).toEqual(new Set(["MyClass", "InlineA"]));
  });

  it("should build a nested tree", () => {
    const usageByClass = new Map([
      ["Root", 10],
      ["ChildA", 50],
      ["ChildB", 30],
    ]);
    const deps = new Map([
      ["Root", new Set(["ChildA"])],
      ["ChildA", new Set(["ChildB"])],
    ]);
    const classes = new Map([
      ["Root", { isStub: false, isUdonBehaviour: false }],
      ["ChildA", { isStub: false, isUdonBehaviour: false }],
      ["ChildB", { isStub: false, isUdonBehaviour: false }],
    ]);

    const { tree } = buildHeapTree(
      "Root",
      usageByClass,
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    expect(tree.className).toBe("Root");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.className).toBe("ChildA");
    expect(tree.children[0]?.children).toHaveLength(1);
    expect(tree.children[0]?.children[0]?.className).toBe("ChildB");
  });

  it("should skip stub classes", () => {
    const usageByClass = new Map([
      ["Root", 10],
      ["StubClass", 50],
    ]);
    const deps = new Map([["Root", new Set(["StubClass"])]]);
    const classes = new Map([
      ["Root", { isStub: false, isUdonBehaviour: false }],
      ["StubClass", { isStub: true, isUdonBehaviour: false }],
    ]);

    const { tree } = buildHeapTree(
      "Root",
      usageByClass,
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    expect(tree.children).toHaveLength(0);
  });

  it("should skip UdonBehaviour-decorated classes", () => {
    const usageByClass = new Map([
      ["Root", 10],
      ["OtherBehaviour", 50],
    ]);
    const deps = new Map([["Root", new Set(["OtherBehaviour"])]]);
    const classes = new Map([
      ["Root", { isStub: false, isUdonBehaviour: false }],
      ["OtherBehaviour", { isStub: false, isUdonBehaviour: true }],
    ]);

    const { tree } = buildHeapTree(
      "Root",
      usageByClass,
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    expect(tree.children).toHaveLength(0);
  });

  it("should handle circular references by claiming each class once", () => {
    const usageByClass = new Map([
      ["A", 10],
      ["B", 20],
    ]);
    const deps = new Map([
      ["A", new Set(["B"])],
      ["B", new Set(["A"])],
    ]);
    const classes = new Map([
      ["A", { isStub: false, isUdonBehaviour: false }],
      ["B", { isStub: false, isUdonBehaviour: false }],
    ]);

    const { tree, claimed } = buildHeapTree(
      "A",
      usageByClass,
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    expect(tree.className).toBe("A");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.className).toBe("B");
    expect(tree.children[0]?.children).toHaveLength(0);
    expect(claimed).toEqual(new Set(["A", "B"]));
  });

  it("should claim a class only once when referenced by multiple parents", () => {
    const usageByClass = new Map([
      ["Root", 10],
      ["ChildA", 20],
      ["ChildB", 30],
      ["Shared", 40],
    ]);
    const deps = new Map([
      ["Root", new Set(["ChildA", "ChildB"])],
      ["ChildA", new Set(["Shared"])],
      ["ChildB", new Set(["Shared"])],
    ]);
    const classes = new Map([
      ["Root", { isStub: false, isUdonBehaviour: false }],
      ["ChildA", { isStub: false, isUdonBehaviour: false }],
      ["ChildB", { isStub: false, isUdonBehaviour: false }],
      ["Shared", { isStub: false, isUdonBehaviour: false }],
    ]);

    const { tree, claimed } = buildHeapTree(
      "Root",
      usageByClass,
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    expect(claimed).toEqual(new Set(["Root", "ChildA", "ChildB", "Shared"]));
    // Shared should appear under exactly one child
    const sharedCount = tree.children.reduce(
      (count, child) =>
        count + child.children.filter((c) => c.className === "Shared").length,
      0,
    );
    expect(sharedCount).toBe(1);
  });

  it("should treat unregistered class as unclaimed root entry", () => {
    // "Unregistered" is referenced by Root but not in the ClassRegistry,
    // so isSkippableClass returns true and it stays unclaimed.
    const usageByClass = new Map([
      ["Root", 10],
      ["Unregistered", 40],
    ]);
    const deps = new Map([["Root", new Set(["Unregistered"])]]);
    // Only Root is in the registry; Unregistered is absent.
    const classes = new Map([
      ["Root", { isStub: false, isUdonBehaviour: false }],
    ]);

    const { tree, claimed } = buildHeapTree(
      "Root",
      usageByClass,
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    expect(tree.children).toHaveLength(0);
    expect(claimed).not.toContain("Unregistered");

    // Verify it shows as unclaimed root entry in the breakdown
    const result = buildHeapUsageTreeBreakdown(
      usageByClass,
      50,
      "Root",
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );
    const lines = result.split("\n");
    expect(lines).toContain("  - Unregistered: 40");
  });

  it("should skip children not present in usageByClass", () => {
    const usageByClass = new Map([["Root", 10]]);
    const deps = new Map([["Root", new Set(["Missing"])]]);
    const classes = new Map([
      ["Root", { isStub: false, isUdonBehaviour: false }],
      ["Missing", { isStub: false, isUdonBehaviour: false }],
    ]);

    const { tree } = buildHeapTree(
      "Root",
      usageByClass,
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    expect(tree.children).toHaveLength(0);
  });

  it("should sort children by totalUsage (subtree) descending", () => {
    // SmallSelf has low selfUsage but large subtree via DeepChild
    const usageByClass = new Map([
      ["Root", 10],
      ["SmallSelf", 5],
      ["DeepChild", 200],
      ["LargeSelf", 100],
    ]);
    const deps = new Map([
      ["Root", new Set(["SmallSelf", "LargeSelf"])],
      ["SmallSelf", new Set(["DeepChild"])],
    ]);
    const classes = new Map([
      ["Root", { isStub: false, isUdonBehaviour: false }],
      ["SmallSelf", { isStub: false, isUdonBehaviour: false }],
      ["DeepChild", { isStub: false, isUdonBehaviour: false }],
      ["LargeSelf", { isStub: false, isUdonBehaviour: false }],
    ]);

    const { tree } = buildHeapTree(
      "Root",
      usageByClass,
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    // SmallSelf totalUsage = 5 + 200 = 205 > LargeSelf totalUsage = 100
    expect(tree.children.map((c) => c.className)).toEqual([
      "SmallSelf",
      "LargeSelf",
    ]);
    expect(tree.children[0]?.totalUsage).toBe(205);
    expect(tree.children[1]?.totalUsage).toBe(100);
    expect(tree.totalUsage).toBe(315);
  });
});

describe("buildHeapUsageTreeBreakdown", () => {
  it("should render a tree with indentation", () => {
    const usageByClass = new Map([
      ["MyClass", 35],
      ["InlineA", 156],
      ["<temporary>", 123],
    ]);
    const deps = new Map([["MyClass", new Set(["InlineA"])]]);
    const classes = new Map([
      ["MyClass", { isStub: false, isUdonBehaviour: false }],
      ["InlineA", { isStub: false, isUdonBehaviour: false }],
    ]);

    const result = buildHeapUsageTreeBreakdown(
      usageByClass,
      314,
      "MyClass",
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    const lines = result.split("\n");
    expect(lines[0]).toBe("  - MyClass: 35");
    expect(lines[1]).toBe("    - InlineA: 156");
    expect(lines[2]).toBe("  - <temporary>: 123");
  });

  it("should place unclaimed classes at root level", () => {
    const usageByClass = new Map([
      ["Root", 10],
      ["Orphan", 50],
      ["<extern>", 20],
    ]);
    const deps = new Map<string, Set<string>>([["Root", new Set()]]);
    const classes = new Map([
      ["Root", { isStub: false, isUdonBehaviour: false }],
      ["Orphan", { isStub: false, isUdonBehaviour: false }],
    ]);

    const result = buildHeapUsageTreeBreakdown(
      usageByClass,
      80,
      "Root",
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    const lines = result.split("\n");
    expect(lines[0]).toBe("  - Root: 10");
    // Unclaimed sorted by usage descending
    expect(lines[1]).toBe("  - Orphan: 50");
    expect(lines[2]).toBe("  - <extern>: 20");
  });

  it("should add missing heap usage to entry class", () => {
    const usageByClass = new Map([["Root", 10]]);
    const deps = new Map<string, Set<string>>([["Root", new Set()]]);
    const classes = new Map([
      ["Root", { isStub: false, isUdonBehaviour: false }],
    ]);

    const result = buildHeapUsageTreeBreakdown(
      usageByClass,
      100,
      "Root",
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    expect(result).toBe("  - Root: 100");
  });

  it("should render a deeply nested tree", () => {
    const usageByClass = new Map([
      ["A", 10],
      ["B", 20],
      ["C", 30],
    ]);
    const deps = new Map([
      ["A", new Set(["B"])],
      ["B", new Set(["C"])],
    ]);
    const classes = new Map([
      ["A", { isStub: false, isUdonBehaviour: false }],
      ["B", { isStub: false, isUdonBehaviour: false }],
      ["C", { isStub: false, isUdonBehaviour: false }],
    ]);

    const result = buildHeapUsageTreeBreakdown(
      usageByClass,
      60,
      "A",
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    const lines = result.split("\n");
    expect(lines[0]).toBe("  - A: 10");
    expect(lines[1]).toBe("    - B: 20");
    expect(lines[2]).toBe("      - C: 30");
  });

  it("should sort unclaimed classes by usage descending", () => {
    const usageByClass = new Map([
      ["Root", 5],
      ["<temporary>", 100],
      ["<extern>", 10],
      ["Unclaimed", 50],
    ]);
    const deps = new Map<string, Set<string>>([["Root", new Set()]]);
    const classes = new Map([
      ["Root", { isStub: false, isUdonBehaviour: false }],
    ]);

    const result = buildHeapUsageTreeBreakdown(
      usageByClass,
      165,
      "Root",
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    const lines = result.split("\n");
    expect(lines[0]).toBe("  - Root: 5");
    expect(lines[1]).toBe("  - <temporary>: 100");
    expect(lines[2]).toBe("  - Unclaimed: 50");
    expect(lines[3]).toBe("  - <extern>: 10");
  });

  it("should not create phantom entry when usageByClass is empty", () => {
    const usageByClass = new Map<string, number>();
    const deps = new Map<string, Set<string>>([["Root", new Set()]]);
    const classes = new Map([
      ["Root", { isStub: false, isUdonBehaviour: false }],
    ]);

    const result = buildHeapUsageTreeBreakdown(
      usageByClass,
      50,
      "Root",
      createMockCallAnalyzer(deps),
      createMockRegistry(classes),
    );

    // Root has 0 usage since it wasn't in the original map and no deficit is assigned
    expect(result).toBe("  - Root: 0");
  });
});

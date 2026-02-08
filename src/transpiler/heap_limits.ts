import type { CallAnalyzer } from "./frontend/call_analyzer.js";
import type { ClassRegistry } from "./frontend/class_registry.js";

export const UASM_HEAP_LIMIT = 512;
// Initial value for heap address reduction; allows empty data to evaluate to 0.
export const HEAP_SIZE_INITIAL_VALUE = -1;

// [name, address, type, value]
export type HeapDataEntry = [string, number, string, unknown];

export interface HeapTreeNode {
  className: string;
  selfUsage: number;
  children: HeapTreeNode[];
}

export const computeHeapUsage = (dataSection: HeapDataEntry[]): number => {
  if (dataSection.length === 0) {
    return 0;
  }
  const heapSize = dataSection.reduce(
    (max, [, address]) => Math.max(max, address),
    HEAP_SIZE_INITIAL_VALUE,
  );
  return heapSize + 1;
};

export const buildHeapUsageBreakdown = (
  usageByClass: Map<string, number>,
  heapUsage: number,
  defaultClass: string,
  inlineClassNames?: Set<string>,
): string => {
  const updatedUsage = new Map(usageByClass);
  if (inlineClassNames) {
    for (const inlineClass of inlineClassNames) {
      if (!updatedUsage.has(inlineClass)) {
        updatedUsage.set(inlineClass, 0);
      }
    }
  }
  const totalUsage = Array.from(updatedUsage.values()).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (totalUsage < heapUsage) {
    updatedUsage.set(
      defaultClass,
      (updatedUsage.get(defaultClass) ?? 0) + (heapUsage - totalUsage),
    );
  }

  return Array.from(updatedUsage.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([className, count]) => `  - ${className}: ${count}`)
    .join("\n");
};

const isSkippableClass = (
  className: string,
  registry: ClassRegistry,
): boolean => {
  if (registry.isStub(className)) return true;
  const meta = registry.getClass(className);
  if (!meta) return true;
  return meta.decorators.some(
    (decorator) => decorator.name === "UdonBehaviour",
  );
};

const buildTreeNode = (
  className: string,
  usageByClass: Map<string, number>,
  callAnalyzer: CallAnalyzer,
  registry: ClassRegistry,
  claimed: Set<string>,
): HeapTreeNode => {
  const analysis = callAnalyzer.analyzeClass(className);
  const children: HeapTreeNode[] = [];

  for (const childName of analysis.inlineClasses) {
    if (claimed.has(childName)) continue;
    if (isSkippableClass(childName, registry)) continue;
    if (!usageByClass.has(childName)) continue;
    claimed.add(childName);
    children.push(
      buildTreeNode(childName, usageByClass, callAnalyzer, registry, claimed),
    );
  }

  children.sort((a, b) => b.selfUsage - a.selfUsage);

  return {
    className,
    selfUsage: usageByClass.get(className) ?? 0,
    children,
  };
};

export const buildHeapTree = (
  entryClassName: string,
  usageByClass: Map<string, number>,
  callAnalyzer: CallAnalyzer,
  registry: ClassRegistry,
): { tree: HeapTreeNode; claimed: Set<string> } => {
  const claimed = new Set<string>([entryClassName]);
  const tree = buildTreeNode(
    entryClassName,
    usageByClass,
    callAnalyzer,
    registry,
    claimed,
  );
  return { tree, claimed };
};

const renderTreeNode = (
  node: HeapTreeNode,
  indent: string,
  lines: string[],
): void => {
  lines.push(`${indent}- ${node.className}: ${node.selfUsage}`);
  const childIndent = `${indent}  `;
  for (const child of node.children) {
    renderTreeNode(child, childIndent, lines);
  }
};

export const buildHeapUsageTreeBreakdown = (
  usageByClass: Map<string, number>,
  heapUsage: number,
  entryClassName: string,
  callAnalyzer: CallAnalyzer,
  registry: ClassRegistry,
): string => {
  const updatedUsage = new Map(usageByClass);
  const totalUsage = Array.from(updatedUsage.values()).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (totalUsage < heapUsage) {
    updatedUsage.set(
      entryClassName,
      (updatedUsage.get(entryClassName) ?? 0) + (heapUsage - totalUsage),
    );
  }

  const { tree, claimed } = buildHeapTree(
    entryClassName,
    updatedUsage,
    callAnalyzer,
    registry,
  );

  const lines: string[] = [];
  renderTreeNode(tree, "  ", lines);

  // Add unclaimed classes at root level
  const unclaimed = Array.from(updatedUsage.entries())
    .filter(([name]) => !claimed.has(name))
    .sort((a, b) => b[1] - a[1]);
  for (const [name, usage] of unclaimed) {
    lines.push(`  - ${name}: ${usage}`);
  }

  return lines.join("\n");
};

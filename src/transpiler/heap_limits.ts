import type { CallAnalyzer } from "./frontend/call_analyzer.js";
import type { ClassRegistry } from "./frontend/class_registry.js";

// Compile-time heap caps per output format.
// UASM_HEAP_LIMIT (512): default UdonAssemblyProgramAsset heap size.
// TASM_HEAP_LIMIT (1048576): maximum Udon VM heap capacity (MAXIMUM_CAPACITY).
// UASM_RUNTIME_LIMIT (65536): practical Udon runtime threshold; crossing this
//   triggers a warning but does not block compilation.
export const UASM_HEAP_LIMIT = 512;
export const TASM_HEAP_LIMIT = 1048576;
export const UASM_RUNTIME_LIMIT = 65536;
// Initial value for heap address reduction; allows empty data to evaluate to 0.
export const HEAP_SIZE_INITIAL_VALUE = -1;

// [name, address, type, value]
export type HeapDataEntry = [string, number, string, unknown];

export interface HeapTreeNode {
  className: string;
  selfUsage: number;
  totalUsage: number;
  children: HeapTreeNode[];
}

/**
 * Assign the gap between tracked per-class totals and actual heap usage to
 * defaultClass. Only adds the deficit when there is already real tracked
 * usage (totalUsage > 0) or when defaultClass already has an entry, so we
 * don't create a phantom entry from an empty map.
 */
const assignHeapDeficit = (
  usageByClass: Map<string, number>,
  heapUsage: number,
  defaultClass: string,
): void => {
  const totalUsage = Array.from(usageByClass.values()).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (totalUsage >= heapUsage) return;
  if (totalUsage === 0 && !usageByClass.has(defaultClass)) return;
  usageByClass.set(
    defaultClass,
    (usageByClass.get(defaultClass) ?? 0) + (heapUsage - totalUsage),
  );
};

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
  assignHeapDeficit(updatedUsage, heapUsage, defaultClass);

  return Array.from(updatedUsage.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([className, count]) => `  - ${className}: ${count}`)
    .join("\n");
};

/**
 * Returns true for classes that should not appear as tree children.
 * Unregistered classes (getClass returns undefined) are treated as skippable
 * so they surface as unclaimed root-level entries in the breakdown rather
 * than being nested under a parent that may not actually depend on them.
 */
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

  children.sort((a, b) => b.totalUsage - a.totalUsage);

  const selfUsage = usageByClass.get(className) ?? 0;
  const totalUsage =
    selfUsage + children.reduce((sum, child) => sum + child.totalUsage, 0);

  return {
    className,
    selfUsage,
    totalUsage,
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
  assignHeapDeficit(updatedUsage, heapUsage, entryClassName);

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
